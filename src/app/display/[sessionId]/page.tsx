'use client';

import { useState, useEffect, useCallback, useRef, use } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { fetchScoreboard, type ScoreRow } from '@/lib/scoreboard';
import { fetchPickItems, computeCurrentTierAsync, fetchSequenceResults, fetchWinner, type PickItem, type TierResult, type SequenceResult, type WinnerInfo } from '@/lib/liveEngine';
import { questionTypeForRound } from '@/lib/questionSet';
import { arabicClass, arabicDir } from '@/lib/textDir';
import { playBuzzAlert } from '@/lib/buzzSound';
import { questionImages } from '@/lib/media';

// No `answer` field: the correct answer is fetched only once the host reveals it (see the
// revealedAnswer effect below). It used to be pulled in with the question itself, which put the
// answer key in the browser — visible in the network tab — while teams were still answering.
type Question = { id: string; text: string; type: string; media_url: string | null; media_urls?: string[] | null };
type Option = { option_key: string; option_text: string };
type Round = { id: string; sequence_no: number; name: string; round_type: string; team_picks_category?: boolean; category_ids?: string[] | null };

export default function DisplayPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [sessionData, setSessionData] = useState<any>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [sequenceItems, setSequenceItems] = useState<Option[]>([]);
  const [correctSequence, setCorrectSequence] = useState<string[]>([]);
  const [seqResults, setSeqResults] = useState<SequenceResult[]>([]);
  const [winner, setWinner] = useState<WinnerInfo | null>(null);
  const [revealedAnswer, setRevealedAnswer] = useState<string | null>(null);
  const [buzzFirst, setBuzzFirst] = useState<string | null>(null);
  const [buzzOrder, setBuzzOrder] = useState<{ team_id: string; status: string; team_name?: string }[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [timerNow, setTimerNow] = useState(Date.now());
  const [pickItems, setPickItems] = useState<PickItem[]>([]);
  const [pickerTeamName, setPickerTeamName] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('live_sessions').select('*').eq('id', sessionId).single().then(({ data }) => setSessionData(data));
    const sub = supabase.channel(`display:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_sessions', filter: `id=eq.${sessionId}` }, payload => setSessionData(payload.new))
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId]);

  const prevBuzzCount = useRef(0);
  const refreshBuzz = useCallback(async () => {
    if (!sessionData?.current_question_set_item_id) { setBuzzFirst(null); setBuzzOrder([]); prevBuzzCount.current = 0; return; }
    // Ordered by buzzed_at (the server clock), matching the Host and Team screens exactly — they
    // used to rank by a client-computed `position` that two simultaneous buzzes could tie, so the
    // projector could name a different team as first than the host's own screen.
    const { data } = await supabase.from('buzzer_events').select('team_id, status, teams(name)').eq('session_id', sessionId).eq('question_set_item_id', sessionData.current_question_set_item_id).order('buzzed_at');
    const rows = (data || []).map((b: any) => ({ team_id: b.team_id, status: b.status, team_name: b.teams?.name }));
    // Side effects belong outside a state updater — React may run an updater more than once.
    if (rows.length > prevBuzzCount.current) playBuzzAlert(); // a new team buzzed in
    prevBuzzCount.current = rows.length;
    setBuzzOrder(rows);
    // A rejected buzz (false start) doesn't hold the floor — the next team does. The headline
    // used to keep naming the rejected team while another team was already answering.
    const active = rows.find(r => r.status !== 'rejected') || null;
    setBuzzFirst(active ? `${active.team_name} (${active.status})` : null);
  }, [sessionId, sessionData?.current_question_set_item_id]);

  useEffect(() => { refreshBuzz(); }, [refreshBuzz]);

  // Separate effect so the subscription always calls the CURRENT refreshBuzz. When this lived in
  // the session effect above (deps: [sessionId]) it captured the very first render's version —
  // the one where sessionData is still null — so every incoming buzz ran the early-return branch
  // and cleared the list instead of filling it. The big screen never showed who buzzed at all.
  useEffect(() => {
    const sub = supabase.channel(`display-buzz:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buzzer_events', filter: `session_id=eq.${sessionId}` }, () => refreshBuzz())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId, refreshBuzz]);

  useEffect(() => {
    async function load() {
      setRound(null); setQuestion(null); setOptions([]); setSequenceItems([]); setCorrectSequence([]);
      if (sessionData?.current_round_id) {
        const { data: r } = await supabase.from('rounds').select('id, sequence_no, name, round_type, team_picks_category, category_ids').eq('id', sessionData.current_round_id).single();
        setRound(r || null);
      }
      const itemId = sessionData?.current_question_set_item_id;
      if (!itemId) return;
      const { data: item } = await supabase.from('question_set_items').select('question_id, option_order').eq('id', itemId).single();
      if (!item) return;
      const { data: q } = await supabase.from('questions').select('id, text, type, media_url, media_urls').eq('id', item.question_id).single();
      setQuestion(q || null);
      if (q?.type === 'MCQ') {
        const { data: opts } = await supabase.from('question_options').select('option_key, option_text').eq('question_id', q.id);
        const order: string[] = item.option_order || [];
        setOptions([...(opts || [])].sort((a, b) => order.indexOf(a.option_key) - order.indexOf(b.option_key)));
      } else if (q?.type === 'SEQUENCE') {
        // Shown shuffled (never the correct sort_order) while teams are ordering it themselves.
        const { data: opts } = await supabase.from('question_options').select('option_key, option_text').eq('question_id', q.id);
        const order: string[] = item.option_order || [];
        setSequenceItems([...(opts || [])].sort((a, b) => order.indexOf(a.option_key) - order.indexOf(b.option_key)));
      }
    }
    load();
  }, [sessionData?.current_round_id, sessionData?.current_question_set_item_id]);

  // Who got the Sequencing order right, and how fast — fetched once the question is revealed.
  // Not reset by the question-load effect above (which re-runs on every item/round change) so it
  // isn't blanked by unrelated realtime traffic; it's owned entirely by this effect's own deps.
  useEffect(() => {
    const itemId = sessionData?.current_question_set_item_id;
    if (question?.type !== 'SEQUENCE' || sessionData?.display_state !== 'answer_reveal' || !itemId) {
      setSeqResults([]);
      return;
    }
    let cancelled = false;
    fetchSequenceResults(sessionId, itemId).then(r => { if (!cancelled) setSeqResults(r); });
    return () => { cancelled = true; };
  }, [sessionId, question?.type, sessionData?.display_state, sessionData?.current_question_set_item_id]);

  useEffect(() => {
    if (sessionData?.display_state !== 'winners' || !sessionData?.winner_team_id) { setWinner(null); return; }
    fetchWinner(sessionData.winner_team_id).then(setWinner);
  }, [sessionData?.display_state, sessionData?.winner_team_id]);

  // Live-updating while the scoreboard is up: it used to be a one-shot snapshot taken when the
  // host switched to it, so any correction made while it was on the projector stayed invisible.
  useEffect(() => {
    if (sessionData?.display_state !== 'scoreboard' || !sessionData?.quiz_id) return;
    const quizId = sessionData.quiz_id;
    const reload = () => fetchScoreboard(quizId, sessionId).then(setScoreboard).catch(() => {});
    reload();
    const sub = supabase.channel(`display-scores:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores', filter: `session_id=eq.${sessionId}` }, reload)
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionData?.display_state, sessionData?.quiz_id, sessionId]);

  useEffect(() => {
    if (sessionData?.display_state === 'category_pick' && round?.team_picks_category && sessionData?.current_round_id) {
      fetchPickItems(sessionId, sessionData.current_round_id).then(setPickItems);
    }
  }, [sessionData?.display_state, round?.team_picks_category, sessionData?.current_round_id, sessionId]);

  useEffect(() => {
    if (sessionData?.display_state !== 'category_pick') return;
    const sub = supabase.channel(`display-picks:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'question_set_items' }, () => {
        if (sessionData?.current_round_id) fetchPickItems(sessionId, sessionData.current_round_id).then(setPickItems);
      })
      .subscribe();
    return () => { supabase.removeChannel(sub); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionData?.display_state]);

  useEffect(() => {
    const pickerId = sessionData?.current_picker_team_id;
    if (!pickerId) { setPickerTeamName(null); return; }
    supabase.from('teams').select('name').eq('id', pickerId).single().then(({ data }) => setPickerTeamName(data?.name || null));
  }, [sessionData?.current_picker_team_id]);

  useEffect(() => {
    const t = setInterval(() => setTimerNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const [tier, setTier] = useState<TierResult>({ difficulty: null, categories: [], nextItemId: null, done: true });
  useEffect(() => {
    let cancelled = false;
    computeCurrentTierAsync(pickItems, round?.category_ids, questionTypeForRound(round?.round_type || 'MCQ'))
      .then(t => { if (!cancelled) setTier(t); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pickItems, round?.category_ids, round?.round_type]);

  const state = sessionData?.display_state || 'idle';
  const showAnswer = state === 'answer_reveal';

  useEffect(() => {
    if (!showAnswer || question?.type !== 'SEQUENCE') { setCorrectSequence([]); return; }
    supabase.from('question_options').select('option_text, sort_order').eq('question_id', question.id).order('sort_order')
      .then(({ data }) => setCorrectSequence((data || []).map((o: any) => o.option_text)));
  }, [showAnswer, question]);

  // The answer key is fetched only at reveal, never alongside the question.
  useEffect(() => {
    if (!showAnswer || !question || question.type === 'SEQUENCE') { setRevealedAnswer(null); return; }
    supabase.from('questions').select('answer').eq('id', question.id).single()
      .then(({ data }) => setRevealedAnswer(data?.answer ?? null));
  }, [showAnswer, question]);

  let remaining: number | null = null;
  const ts = sessionData?.timer_state;
  if (ts?.startedAt && !ts.paused) {
    remaining = Math.max(0, Math.round((ts.duration ?? 0) - (timerNow - new Date(ts.startedAt).getTime()) / 1000));
  } else if (ts?.paused) {
    remaining = ts.remaining ?? null;
  }

  return (
    <div className="w-full max-w-6xl text-center">
      {state === 'idle' && (
        <>
          <h1 className="text-8xl font-bold mb-8 bg-gradient-to-r from-blue-400 via-purple-400 to-teal-400 bg-clip-text text-transparent">Live Quiz Show</h1>
          <p className="text-4xl text-gray-400">Waiting for event to begin…</p>
        </>
      )}

      {state === 'round_intro' && round && (
        <div className="rounded-3xl border border-gray-700/50 bg-gradient-to-br from-gray-900 to-gray-950 shadow-2xl px-16 py-14">
          <p className="text-3xl text-gray-400 mb-4 tracking-wide uppercase">Round {round.sequence_no}</p>
          <h1 className={`text-7xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent ${arabicClass(round.name)}`}>{round.name}</h1>
        </div>
      )}

      {state === 'round_complete' && (
        <div className="rounded-3xl border-2 border-emerald-500/60 bg-gradient-to-br from-emerald-950/60 to-gray-950 shadow-2xl px-16 py-14">
          <p className="text-4xl font-bold text-emerald-300 mb-3">✓ Round Complete</p>
          {round && <p className={`text-2xl text-gray-300 ${arabicClass(round.name)}`}>{round.name}</p>}
        </div>
      )}

      {state === 'winners' && (
        winner ? (
          <div className="relative rounded-3xl border-4 border-amber-400/70 bg-gradient-to-br from-amber-950/40 via-gray-950 to-amber-950/40 shadow-2xl shadow-amber-900/50 px-16 py-16 overflow-hidden">
            <p className="text-2xl tracking-[0.3em] text-amber-300/80 uppercase mb-2">Winner</p>
            <h1 className="text-7xl font-black bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-transparent mb-2">🏆</h1>
            <h2 className={`text-6xl font-bold text-white mb-10 ${arabicClass(winner.team_name)}`}>{winner.team_name}</h2>
            {winner.members.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
                {winner.members.map((m, i) => (
                  <div key={i} className="flex flex-col items-center gap-3">
                    <img src={m.photo_url} alt={m.name} className="w-32 h-32 rounded-full object-cover border-4 border-amber-400 shadow-lg shadow-amber-900/50" />
                    <p className={`text-xl font-semibold text-amber-100 ${arabicClass(m.name)}`}>{m.name}</p>
                  </div>
                ))}
              </div>
            ) : winner.logo_url ? (
              <img src={winner.logo_url} alt={winner.team_name} className="w-40 h-40 rounded-full object-cover border-4 border-amber-400 shadow-lg shadow-amber-900/50 mx-auto" />
            ) : null}
          </div>
        ) : (
          <p className="text-3xl text-gray-400">Loading winner…</p>
        )
      )}

      {state === 'category_pick' && round?.team_picks_category && (
        <div>
          {tier.done ? (
            <h2 className="text-5xl font-bold">All categories picked!</h2>
          ) : (
            <>
              <p className="text-2xl text-gray-400 mb-2">Difficulty: {tier.difficulty}</p>
              <h2 className="text-5xl font-bold mb-10">
                {pickerTeamName ? `${pickerTeamName}'s turn to pick a category` : 'Choose a category…'}
              </h2>
              <div className="grid grid-cols-3 gap-6 max-w-4xl mx-auto">
                {tier.categories.map(c => (
                  <div key={c.category_id} className={`bg-gradient-to-br from-blue-900 to-blue-950 rounded-2xl p-8 text-2xl font-semibold border border-gray-700/50 border-l-4 border-l-teal-400 shadow-xl ${arabicClass(c.category_name)}`}>
                    {c.category_name}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {(state === 'question' || state === 'buzzer_open' || state === 'answer_reveal') && question && (
        <div className={`bg-gradient-to-br from-gray-900 to-gray-950 p-12 rounded-3xl border shadow-2xl transition-shadow ${state === 'buzzer_open' ? 'border-red-500/60 shadow-red-900/40' : 'border-gray-700/50'}`}>
          <h2 className={`text-7xl font-bold mb-10 ${arabicClass(question.text)}`}>{question.text}</h2>
          {questionImages(question).length > 0 && (
            <div className={`grid gap-6 mb-10 ${questionImages(question).length > 1 ? 'grid-cols-2 max-w-4xl mx-auto' : ''}`}>
              {questionImages(question).map((url, i) => (
                <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-[28rem] w-full rounded-xl mx-auto shadow-xl object-contain" />
              ))}
            </div>
          )}
          {options.length > 0 && (
            <div className="grid grid-cols-2 gap-8 text-3xl">
              {options.map((o, i) => (
                <div key={o.option_key} className={`p-6 rounded-2xl border-2 transition-all ${showAnswer && o.option_key === revealedAnswer ? 'bg-gradient-to-br from-green-700 to-green-900 border-green-400 shadow-lg shadow-green-900/50' : 'bg-gradient-to-br from-blue-900 to-blue-950 border-gray-700/50 border-l-4 border-l-blue-400'} ${arabicClass(o.option_text)}`}>
                  {String.fromCharCode(65 + i)}. {o.option_text}
                </div>
              ))}
            </div>
          )}
          {showAnswer && options.length === 0 && question.type !== 'SEQUENCE' && revealedAnswer && (
            <div className={`mt-6 text-4xl text-green-400 font-bold ${arabicClass(revealedAnswer)}`}>Answer: {revealedAnswer}</div>
          )}
          {!showAnswer && sequenceItems.length > 0 && (
            <div className="grid grid-cols-1 gap-4 max-w-2xl mx-auto text-2xl">
              {sequenceItems.map(o => (
                <div key={o.option_key} dir={arabicDir(o.option_text)} className={`p-5 rounded-xl bg-gradient-to-br from-blue-900 to-blue-950 border border-gray-700/50 shadow-lg ${arabicClass(o.option_text)}`}>{o.option_text}</div>
              ))}
              <p className="text-lg text-gray-400 mt-2">Teams are arranging these on their own devices…</p>
            </div>
          )}
          {showAnswer && correctSequence.length > 0 && (
            <div className="mt-6">
              <p className="text-2xl text-gray-400 mb-3">Correct order:</p>
              <ol className="flex flex-col gap-2 max-w-2xl mx-auto text-left text-2xl">
                {correctSequence.map((text, i) => (
                  <li key={i} dir={arabicDir(text)} className={`p-4 rounded-xl bg-gradient-to-br from-green-700/70 to-green-900/70 border-2 border-green-400 shadow-lg shadow-green-900/50 ${arabicClass(text)}`}>{i + 1}. {text}</li>
                ))}
              </ol>
            </div>
          )}
          {showAnswer && seqResults.length > 0 && (
            <div className="mt-8">
              <p className="text-2xl text-gray-400 mb-3">Team results — fastest correct first:</p>
              <ol className="flex flex-col gap-3 max-w-2xl mx-auto text-left">
                {[...seqResults]
                  .sort((a, b) => {
                    if (!!a.is_correct !== !!b.is_correct) return a.is_correct ? -1 : 1;
                    return new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime();
                  })
                  .map((r, i) => {
                    const startedAt = (sessionData?.timer_state as { startedAt?: string } | null)?.startedAt;
                    const elapsed = startedAt
                      ? Math.max(0, (new Date(r.submitted_at).getTime() - new Date(startedAt).getTime()) / 1000)
                      : null;
                    return (
                      <li key={r.team_id} className={`flex items-center justify-between gap-4 p-4 rounded-xl border-2 shadow-lg ${r.is_correct ? 'bg-gradient-to-br from-green-700/70 to-green-900/70 border-green-400 shadow-green-900/50' : 'bg-gradient-to-br from-red-900/50 to-red-950/50 border-red-500/60 shadow-red-900/40'}`}>
                        <span className={`text-xl font-semibold ${arabicClass(r.team_name)}`}>
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/40 text-sm font-bold mr-2 align-middle">{i + 1}</span>
                          {r.team_name} {r.is_correct ? '✓' : '✗'}
                        </span>
                        <span className="text-xl font-mono">{elapsed !== null ? `${elapsed.toFixed(1)}s` : '—'}</span>
                      </li>
                    );
                  })}
              </ol>
            </div>
          )}
          {remaining !== null && round?.round_type !== 'BUZZER' && round?.round_type !== 'PICTURE_BUZZER' && (state === 'question' || state === 'buzzer_open') && (
            <div className="mt-10 flex justify-center">
              <div className={`inline-flex items-center justify-center rounded-full w-40 h-40 text-6xl font-mono font-bold border-4 shadow-xl ${remaining <= 5 ? 'border-red-400 text-red-300 bg-red-950/60 shadow-red-900/50 animate-pulse' : remaining <= 10 ? 'border-amber-400 text-amber-300 bg-amber-950/50 shadow-amber-900/40' : 'border-green-400 text-green-300 bg-green-950/40 shadow-green-900/30'}`}>
                {remaining}s
              </div>
            </div>
          )}
          {state === 'buzzer_open' && (
            <div className="mt-10">
              <div className="inline-block px-8 py-4 rounded-2xl bg-red-950/50 border-2 border-red-500/70 shadow-lg shadow-red-900/50">
                <div className="text-4xl text-red-300 animate-pulse font-bold">
                  BUZZER OPEN{buzzFirst ? ` — ${buzzFirst}` : ''}
                </div>
              </div>
              {buzzOrder.length > 0 && (
                <ol className="mt-6 flex flex-col gap-2 max-w-md mx-auto text-left text-xl">
                  {buzzOrder.map((b, i) => (
                    <li key={b.team_id} className={`flex justify-between px-5 py-2 rounded-xl border ${i === 0 ? 'bg-red-900/60 border-red-500/60 font-bold' : 'bg-gray-800/80 border-gray-700/50'}`}>
                      <span className={arabicClass(b.team_name)}>#{i + 1} {b.team_name}</span>
                      <span className="text-gray-300">{b.status}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}

      {state === 'rapid_fire' && (
        <div className="flex flex-col items-center gap-8">
          {pickerTeamName && <h2 className={`text-5xl font-bold ${arabicClass(pickerTeamName)}`}>{pickerTeamName}&apos;s turn</h2>}
          <div className={`inline-flex items-center justify-center rounded-full w-[16rem] h-[16rem] border-4 shadow-2xl text-[10rem] leading-none font-mono font-bold ${typeof remaining === 'number' && remaining <= 5 ? 'border-red-400 text-red-300 bg-red-950/50 shadow-red-900/50 animate-pulse' : typeof remaining === 'number' && remaining <= 10 ? 'border-amber-400 text-amber-300 bg-amber-950/50 shadow-amber-900/40' : 'border-teal-400 text-teal-300 bg-teal-950/40 shadow-teal-900/30'}`}>
            {remaining ?? '--'}
          </div>
        </div>
      )}

      {state === 'scoreboard' && (
        <div className="rounded-3xl border border-gray-700/50 bg-gradient-to-br from-gray-900 to-gray-950 shadow-2xl px-16 py-14">
          <h2 className="text-5xl font-bold mb-10 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">Scoreboard</h2>
          <ol className="flex flex-col gap-3 max-w-2xl mx-auto text-left">
            {scoreboard.map(t => (
              <li key={t.team_id} className={`flex justify-between text-3xl px-8 py-4 rounded-2xl border ${t.eliminated ? 'bg-gray-900/60 border-gray-800 text-gray-600 line-through' : t.rank === 1 ? 'bg-gradient-to-r from-amber-900/50 to-blue-950 border-amber-400/60 shadow-lg shadow-amber-900/30' : 'bg-blue-950/70 border-gray-700/50'}`}>
                <span className={arabicClass(t.name)}>#{t.rank} {t.name}</span>
                <span>{t.total} pts</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {state === 'blank' && <div className="w-full h-[60vh]" />}

      {/* Fallbacks, so the projector never sits on a completely blank screen — which looks
          identical to a crash from the back of the room. */}
      {state === 'question' && !question && <p className="text-4xl text-gray-500">Loading question…</p>}
      {state === 'round_intro' && !round && <p className="text-4xl text-gray-500">Loading round…</p>}
      {!['idle', 'round_intro', 'round_complete', 'category_pick', 'question', 'buzzer_open', 'answer_reveal', 'rapid_fire', 'scoreboard', 'winners', 'blank'].includes(state) && (
        <p className="text-4xl text-gray-500">Standby…</p>
      )}
    </div>
  );
}
