'use client';

import { useState, useEffect, useCallback, useRef, use } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { hashPin } from '@/lib/pin';
import { submitBuzz, submitAnswer, submitSequenceAnswer, fetchPickItems, computeCurrentTierAsync, pickCategory, type PickItem, type TierResult } from '@/lib/liveEngine';
import { arabicClass, arabicDir } from '@/lib/textDir';
import { questionTypeForRound } from '@/lib/questionSet';
import { playBuzzSound } from '@/lib/buzzSound';
import { questionImages } from '@/lib/media';

type Team = { id: string; quiz_id: string; name: string; pin_hash: string; eliminated_at: string | null };
type Question = { id: string; text: string; type: string; media_url: string | null; media_urls?: string[] | null };
type Option = { option_key: string; option_text: string };

export default function TeamPage({ params }: { params: Promise<{ teamCode: string }> }) {
  const { teamCode } = use(params);
  const [team, setTeam] = useState<Team | null>(null);
  const [authed, setAuthed] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<any>(null);
  const [roundType, setRoundType] = useState<string | null>(null);
  const [teamPicksCategory, setTeamPicksCategory] = useState(false);
  const [buzzerEnabled, setBuzzerEnabled] = useState(false);
  const [roundCategoryIds, setRoundCategoryIds] = useState<string[] | null>(null);
  const [pickItems, setPickItems] = useState<PickItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickerTeamName, setPickerTeamName] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [mySelection, setMySelection] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [sequenceOrder, setSequenceOrder] = useState<Option[]>([]);
  const [mySequence, setMySequence] = useState<string[] | null>(null);
  const [buzzPending, setBuzzPending] = useState(false);
  const [buzzOrder, setBuzzOrder] = useState<{ team_id: string; status: string; team_name?: string }[]>([]);
  const [revealedAnswer, setRevealedAnswer] = useState<string | null>(null);
  const [revealedSequence, setRevealedSequence] = useState<string[] | null>(null);
  const [timerNow, setTimerNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTimerNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // 1. resolve team
  useEffect(() => {
    supabase.from('teams').select('id, quiz_id, name, pin_hash, eliminated_at').eq('code', teamCode).single().then(({ data, error }) => {
      if (error || !data) { setNotFound(true); return; }
      setTeam(data);
      try {
        if (sessionStorage.getItem(`team_auth_${data.id}`) === '1') setAuthed(true);
      } catch {}
    });
  }, [teamCode]);

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;
    const hash = await hashPin(pinInput);
    if (hash === team.pin_hash) {
      setAuthed(true);
      setAuthError(null);
      try { sessionStorage.setItem(`team_auth_${team.id}`, '1'); } catch {}
    } else {
      setAuthError('Incorrect PIN.');
    }
  }

  // 2. resolve active live session for this team's quiz
  const resolveSession = useCallback(async () => {
    if (!team) return;
    const { data } = await supabase.from('live_sessions').select('*').eq('quiz_id', team.quiz_id).neq('status', 'ended').order('started_at', { ascending: false }).limit(1).maybeSingle();
    setSessionId(data?.id || null);
    setSessionData(data || null);
  }, [team]);

  useEffect(() => { if (authed) resolveSession(); }, [authed, resolveSession]);

  // 3. subscribe to session state
  useEffect(() => {
    if (!sessionId) return;
    const sub = supabase.channel(`team:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_sessions', filter: `id=eq.${sessionId}` }, payload => setSessionData(payload.new))
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId]);

  // 4. fetch round type + question (no answer key!) whenever current item changes
  useEffect(() => {
    async function load() {
      setMySelection(null);
      setSubmitted(false);
      if (!sessionData?.current_round_id) { setRoundType(null); setTeamPicksCategory(false); setQuestion(null); setOptions([]); setSequenceOrder([]); setMySequence(null); return; }
      const { data: round } = await supabase.from('rounds').select('round_type, buzzer_enabled, team_picks_category, category_ids').eq('id', sessionData.current_round_id).single();
      setRoundType(round?.round_type || null);
      setBuzzerEnabled(!!round?.buzzer_enabled);
      setTeamPicksCategory(!!round?.team_picks_category);
      setRoundCategoryIds(round?.category_ids || null);

      const itemId = sessionData?.current_question_set_item_id;
      // Clear the sequence tiles too, or the previous question's items linger in state.
      if (!itemId) { setQuestion(null); setOptions([]); setSequenceOrder([]); setMySequence(null); return; }
      const { data: item } = await supabase.from('question_set_items').select('question_id, option_order').eq('id', itemId).single();
      if (!item) { setQuestion(null); setOptions([]); setSequenceOrder([]); setMySequence(null); return; }
      const { data: q } = await supabase.from('questions').select('id, text, type, media_url, media_urls').eq('id', item.question_id).single();
      setQuestion(q || null);
      setSequenceOrder([]);
      setMySequence(null);
      if (q?.type === 'MCQ') {
        const { data: opts } = await supabase.from('question_options').select('option_key, option_text').eq('question_id', q.id);
        const order: string[] = item.option_order || [];
        setOptions([...(opts || [])].sort((a, b) => order.indexOf(a.option_key) - order.indexOf(b.option_key)));
      } else if (q?.type === 'SEQUENCE') {
        // Shuffled starting order (item.option_order) — never the correct sort_order — so teams
        // actually have to rearrange it rather than seeing the answer already in place.
        const { data: opts } = await supabase.from('question_options').select('option_key, option_text').eq('question_id', q.id);
        const order: string[] = item.option_order || [];
        setSequenceOrder([...(opts || [])].sort((a, b) => order.indexOf(a.option_key) - order.indexOf(b.option_key)));
        setOptions([]);
      } else {
        setOptions([]);
      }

      // What this team already submitted, and their buzz, are both loaded elsewhere now: the
      // submission by its own effect (which also re-runs on display_state changes, so a host
      // "Reset Question" unlocks the form again) and the buzz derived from the live buzz list.
    }
    load();
  }, [sessionData?.current_round_id, sessionData?.current_question_set_item_id, sessionId, team]);

  function moveSequenceItem(i: number, dir: -1 | 1) {
    setSequenceOrder(prev => {
      const arr = [...prev];
      const j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
  }

  async function handleSubmitSequence() {
    if (!team || !sessionId || !sessionData?.current_question_set_item_id || submitted || submittingRef.current || timeUp || sequenceOrder.length === 0) return;
    submittingRef.current = true;
    const orderedKeys = sequenceOrder.map(o => o.option_key);
    setMySequence(orderedKeys);
    const { error } = await submitSequenceAnswer(sessionId, sessionData.current_question_set_item_id, team.id, orderedKeys);
    if (error) { submittingRef.current = false; setMySequence(null); alert('Your order did not save — tap Submit again.'); return; }
    setSubmitted(true);
  }

  // 5. while in category-pick mode, keep the list of pickable categories live
  const refreshPickItems = useCallback(async () => {
    if (!sessionId || !sessionData?.current_round_id || !teamPicksCategory) { setPickItems([]); return; }
    setPickItems(await fetchPickItems(sessionId, sessionData.current_round_id));
  }, [sessionId, sessionData?.current_round_id, teamPicksCategory]);

  useEffect(() => { refreshPickItems(); }, [refreshPickItems, sessionData?.display_state]);

  const [tier, setTier] = useState<TierResult>({ difficulty: null, categories: [], nextItemId: null, done: true });
  useEffect(() => {
    let cancelled = false;
    computeCurrentTierAsync(pickItems, roundCategoryIds, questionTypeForRound(roundType || 'MCQ'))
      .then(t => { if (!cancelled) setTier(t); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pickItems, roundCategoryIds, roundType]);

  useEffect(() => {
    const pickerId = sessionData?.current_picker_team_id;
    if (!pickerId) { setPickerTeamName(null); return; }
    supabase.from('teams').select('name').eq('id', pickerId).single().then(({ data }) => setPickerTeamName(data?.name || null));
  }, [sessionData?.current_picker_team_id]);

  useEffect(() => {
    if (!sessionId || !teamPicksCategory) return;
    const sub = supabase.channel(`team-picks:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'question_set_items' }, () => refreshPickItems())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId, teamPicksCategory, refreshPickItems]);

  // Live "who buzzed first" — every team subscribes so a losing team's button locks out and
  // shows who beat them, instead of just silently sitting on "pending" forever.
  const refreshBuzzOrder = useCallback(async () => {
    const itemId = sessionData?.current_question_set_item_id;
    if (!sessionId || !itemId) { setBuzzOrder([]); return; }
    // Ordered by the server clock, same as the Host and Display screens — see submitBuzz.
    const { data } = await supabase.from('buzzer_events').select('team_id, status, teams(name)')
      .eq('session_id', sessionId).eq('question_set_item_id', itemId).order('buzzed_at');
    setBuzzOrder((data || []).map((b: any) => ({ team_id: b.team_id, status: b.status, team_name: b.teams?.name })));
  }, [sessionId, sessionData?.current_question_set_item_id]);

  useEffect(() => { refreshBuzzOrder(); }, [refreshBuzzOrder]);

  useEffect(() => {
    if (!sessionId) return;
    const sub = supabase.channel(`team-buzz:${sessionId}:${teamCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buzzer_events', filter: `session_id=eq.${sessionId}` }, () => refreshBuzzOrder())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId, teamCode, refreshBuzzOrder]);

  // myBuzz is DERIVED from the live buzz list rather than held as its own state. Held separately,
  // it was only ever cleared when the question changed — so after the host hit "Reset Buzzer"
  // (which deletes the rows), this team's screen stayed stuck on "Buzzed! Waiting for host…"
  // forever and they couldn't take part in the re-run without reloading the page.
  const myBuzzRow = team ? buzzOrder.find(b => b.team_id === team.id) || null : null;
  const myBuzz = myBuzzRow || (buzzPending ? { status: 'pending' } : null);

  useEffect(() => { if (myBuzzRow) setBuzzPending(false); }, [myBuzzRow]);
  useEffect(() => { setBuzzPending(false); }, [sessionData?.current_question_set_item_id, sessionData?.display_state]);

  // The countdown, computed for every round type (not just Rapid Fire). Teams previously had no
  // clock at all on a normal question AND no time limit enforced — the option buttons stayed live
  // until the host got round to revealing, so an answer tapped well after time was up still
  // counted, which is unfair on the teams that answered honestly inside the limit.
  let remaining: number | null = null;
  const ts = sessionData?.timer_state;
  if (ts?.startedAt && !ts.paused) {
    remaining = Math.max(0, Math.ceil((ts.duration ?? 0) - (timerNow - new Date(ts.startedAt).getTime()) / 1000));
  } else if (ts?.paused) {
    remaining = ts.remaining ?? null;
  }
  const timeUp = remaining !== null && remaining <= 0;
  const submittingRef = useRef(false);

  // Re-check what this team has already submitted whenever the question OR the display state
  // changes. Keyed only on the question before, so a host "Reset Question" (which deletes the
  // answers and returns to the same question) left every team stuck on "Answer submitted" with
  // no way to answer the re-run.
  useEffect(() => {
    const itemId = sessionData?.current_question_set_item_id;
    if (!team || !sessionId || !itemId) return;
    let cancelled = false;
    supabase.from('answers').select('answer_json')
      .eq('session_id', sessionId).eq('question_set_item_id', itemId).eq('team_id', team.id).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setSubmitted(!!data);
        submittingRef.current = !!data;
        setMySelection(data?.answer_json?.selected ?? null);
        setMySequence(data?.answer_json?.order ?? null);
      });
    return () => { cancelled = true; };
  }, [sessionId, sessionData?.current_question_set_item_id, sessionData?.display_state, team]);

  // An eliminated team's own device never found out — it kept showing the buzzer and options
  // because the team row was read once on mount and never watched.
  useEffect(() => {
    if (!team?.id) return;
    const sub = supabase.channel(`team-row:${team.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'teams', filter: `id=eq.${team.id}` },
        payload => setTeam(payload.new as Team))
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [team?.id]);

  // The correct answer is deliberately never fetched for a team until the host actually reveals
  // it (display_state === 'answer_reveal') — this keeps the answer key out of the browser for
  // the whole rest of the question.
  useEffect(() => {
    if (sessionData?.display_state !== 'answer_reveal' || !question) { setRevealedAnswer(null); setRevealedSequence(null); return; }
    if (question.type === 'SEQUENCE') {
      supabase.from('question_options').select('option_text, sort_order').eq('question_id', question.id).order('sort_order')
        .then(({ data }) => setRevealedSequence((data || []).map((o: any) => o.option_text)));
    } else {
      supabase.from('questions').select('answer').eq('id', question.id).single().then(({ data }) => setRevealedAnswer(data?.answer || null));
    }
  }, [sessionData?.display_state, question]);

  async function handlePickCategory(categoryId: string) {
    if (!team || !sessionId || picking || !tier.nextItemId) return;
    setPicking(true);
    try {
      await pickCategory(sessionId, tier.nextItemId, team.id, categoryId);
    } catch (e: any) {
      alert(e.message || 'Failed to pick that category.');
    }
    setPicking(false);
  }

  async function handleSubmitAnswer(key: string) {
    // submittingRef, not `submitted`: the state flag only flips after the round-trip, so two
    // quick taps both passed the guard and the second one overwrote the first (submitAnswer is an
    // upsert, so last write won). timeUp stops answers landing after the clock runs out.
    if (!team || !sessionId || !sessionData?.current_question_set_item_id || submitted || submittingRef.current || timeUp) return;
    submittingRef.current = true;
    setMySelection(key);
    const { error } = await submitAnswer(sessionId, sessionData.current_question_set_item_id, team.id, key);
    if (error) { submittingRef.current = false; setMySelection(null); alert('Your answer did not save — tap again.'); return; }
    setSubmitted(true);
  }

  async function handleBuzz() {
    // Every active team can buzz in independently — one team buzzing first no longer locks the
    // others out. Each team's own button disables only once THEY have buzzed (myBuzz); the host
    // sees everyone's buzz in arrival order (see Buzzer Activity on the host screen) and judges
    // them one at a time.
    if (!team || !sessionId || !sessionData?.current_question_set_item_id || myBuzz || buzzPending) return;
    setBuzzPending(true);
    playBuzzSound();
    const { error } = await submitBuzz(sessionId, sessionData.current_question_set_item_id, team.id);
    // Roll back rather than leaving them looking buzzed-in when nothing was recorded.
    if (error) { setBuzzPending(false); alert('Your buzz did not register — tap again.'); return; }
    refreshBuzzOrder();
  }

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <div className="text-center p-8 bg-white rounded-2xl shadow-lg border border-gray-100 max-w-xs w-full">
          <p className="text-xl font-semibold text-red-600">Team &quot;{teamCode}&quot; not found.</p>
        </div>
      </div>
    );
  }

  if (!team) return <div className="flex justify-center min-h-[60vh] items-center text-gray-500">Loading…</div>;

  if (!authed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <form onSubmit={handlePinSubmit} className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 flex flex-col gap-4 w-full max-w-xs">
          <h2 className={`text-2xl font-bold text-center text-gray-900 ${arabicClass(team.name)}`}>{team.name}</h2>
          <p className="text-sm text-gray-500 text-center">Enter your team PIN to join.</p>
          <input autoFocus type="password" inputMode="numeric" placeholder="PIN" value={pinInput}
            onChange={e => setPinInput(e.target.value)}
            className="border border-gray-200 rounded-xl p-4 text-center text-xl tracking-[0.3em] font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition" />
          {authError && (
            <p className="text-red-600 text-sm text-center bg-red-50 border border-red-100 rounded-lg py-2 px-3 font-medium">{authError}</p>
          )}
          <button type="submit"
            className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white py-4 rounded-xl font-semibold text-lg shadow-md transition active:scale-95">
            Join
          </button>
        </form>
      </div>
    );
  }

  if (team.eliminated_at) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <div className="text-center p-8 bg-white rounded-2xl shadow-lg border border-gray-100 max-w-xs w-full">
          <p className="text-xl text-gray-900 font-bold">{team.name} has been eliminated.</p>
          <p className="text-sm text-gray-500 mt-2">Thanks for playing — you can keep watching the display.</p>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <p className="text-gray-500 font-medium">Connecting to session…</p>
      </div>
    );
  }

  const state = sessionData?.display_state || 'idle';
  // buzzerEnabled matters as well as round type: the host's Open Buzzer button is gated on the
  // round's buzzer_enabled flag, not its type, so an MCQ round with the buzzer switched on used
  // to push display_state to 'buzzer_open' — a state no branch here matched, leaving every team's
  // screen completely blank with the projector still saying BUZZER OPEN.
  const isBuzzerRound = roundType === 'BUZZER' || roundType === 'PICTURE_BUZZER' || buzzerEnabled;
  const isMyTurn = teamPicksCategory && team && sessionData?.current_picker_team_id === team.id;
  const questionMedia = questionImages(question);

  const rapidFireRemaining = remaining;

  const timerColor = remaining === null ? '' : timeUp ? 'text-red-600 bg-red-50 border-red-200' : remaining <= 5 ? 'text-orange-500 bg-orange-50 border-orange-200' : 'text-green-600 bg-green-50 border-green-200';

  return (
    <div className={`flex flex-col items-center justify-center min-h-[60vh] gap-6 w-full max-w-lg mx-auto px-4 py-6 ${arabicClass(team.name)}`}>
      <h2 className={`text-2xl font-bold text-gray-900 tracking-tight ${arabicClass(team.name)}`}>{team.name}</h2>

      {/* The countdown, so teams can see how long they've got instead of guessing. Buzzer rounds
          have no time limit to answer once buzzed — it's a race to buzz, not a countdown — so the
          clock is skipped there entirely. */}
      {remaining !== null && !isBuzzerRound && (state === 'question' || state === 'buzzer_open') && (
        <div className={`text-4xl font-mono font-extrabold border-2 rounded-2xl px-6 py-2 shadow-sm transition-colors ${timerColor}`}>
          {timeUp ? "Time's up" : `${remaining}s`}
        </div>
      )}

      {state === 'idle' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-gray-100 text-gray-600 border border-gray-200">
          Waiting for the host to start the quiz…
        </span>
      )}
      {state === 'round_intro' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-blue-50 text-blue-700 border border-blue-100">
          Get ready — next round is starting!
        </span>
      )}
      {state === 'round_complete' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
          ✓ Round complete — waiting for the host to start the next round…
        </span>
      )}
      {state === 'winners' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-amber-50 text-amber-700 border border-amber-100">
          🏆 The winner has been announced — check the projector!
        </span>
      )}

      {state === 'category_pick' && teamPicksCategory && (
        <div className="w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-6 sm:p-8 text-center">
          {tier.done ? (
            <p className="text-gray-500 font-medium">All categories have been picked for this round.</p>
          ) : isMyTurn ? (
            <>
              <p className="text-lg font-bold text-gray-900 mb-1">Your turn! Choose a category</p>
              <span className="inline-block rounded-full px-3 py-1 text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-100 mb-5">
                Difficulty: {tier.difficulty}
              </span>
              <div className="grid grid-cols-2 gap-3">
                {tier.categories.map(c => (
                  <button key={c.category_id} disabled
                    className={`relative bg-gray-100 text-gray-400 border border-gray-200 rounded-xl p-4 font-semibold cursor-not-allowed ${arabicClass(c.category_name)}`}>
                    <span className="absolute top-1.5 right-1.5 text-xs">🔒</span>
                    {c.category_name}
                  </button>
                ))}
              </div>
              <p className="text-sm text-gray-600 mt-5 bg-orange-50 border border-orange-100 rounded-xl py-2 px-3 font-medium">📢 Call out your category choice — the host will select it for you.</p>
            </>
          ) : (
            <p className="text-gray-500">
              Waiting for <span className={`font-semibold text-gray-700 ${arabicClass(pickerTeamName)}`}>{pickerTeamName || 'the other team'}</span> to call out their category. Host is selecting…
            </p>
          )}
        </div>
      )}

      {state === 'question' && question && question.type === 'MCQ' && !isBuzzerRound && (
        <div className="w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-6 sm:p-8">
          <p className={`text-lg font-semibold text-gray-900 mb-4 ${arabicClass(question.text)}`}>{question.text}</p>
          {questionMedia.length > 0 && (
            <div className={`grid gap-2 mb-4 ${questionMedia.length > 1 ? 'grid-cols-2' : ''}`}>
              {questionMedia.map((url, i) => (
                <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-72 rounded-xl mx-auto object-contain" />
              ))}
            </div>
          )}
          {submitted ? (
            <p className="rounded-xl bg-green-50 border border-green-100 text-green-700 font-semibold px-4 py-3">
              ✓ Answer submitted{mySelection ? `: ${String.fromCharCode(65 + Math.max(0, options.findIndex(o => o.option_key === mySelection)))}` : ''}. Waiting for reveal…
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-600 mb-3 font-medium bg-orange-50 border border-orange-100 rounded-xl py-2 px-3">👀 Teams can view but cannot select. The host controls the quiz.</p>
              <div className="grid grid-cols-1 gap-2">
                {options.map((o, i) => (
                  <button key={o.option_key} disabled
                    className="relative text-left border border-gray-200 rounded-xl p-3 bg-gray-50 cursor-not-allowed text-gray-400 opacity-70">
                    <span className={arabicClass(o.option_text)}><b>{String.fromCharCode(65 + i)}.</b> {o.option_text}</span>
                    <span className="absolute top-2 right-2 text-xs">🔒</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {state === 'question' && question && question.type === 'SEQUENCE' && (
        <div className="w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-6 sm:p-8">
          <p className={`text-lg font-semibold text-gray-900 mb-4 ${arabicClass(question.text)}`}>{question.text}</p>
          {questionMedia.length > 0 && (
            <div className={`grid gap-2 mb-4 ${questionMedia.length > 1 ? 'grid-cols-2' : ''}`}>
              {questionMedia.map((url, i) => (
                <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-72 rounded-xl mx-auto object-contain" />
              ))}
            </div>
          )}
          {submitted ? (
            <div>
              <p className="rounded-xl bg-green-50 border border-green-100 text-green-700 font-semibold px-4 py-3 mb-3">✓ Order submitted. Waiting for reveal…</p>
              <ol className="flex flex-col gap-1 text-sm text-gray-600">
                {(mySequence || []).map((key, i) => {
                  const opt = sequenceOrder.find(o => o.option_key === key);
                  return <li key={key} dir={arabicDir(opt?.option_text)}>{i + 1}. {opt ? <span className={arabicClass(opt.option_text)}>{opt.option_text}</span> : key}</li>;
                })}
              </ol>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-3">Use the arrows to put these in the correct order, then submit.</p>
              <div className="flex flex-col gap-2 mb-4">
                {sequenceOrder.map((o, i) => (
                  <div key={o.option_key} dir={arabicDir(o.option_text)} className="flex items-center gap-2 border border-gray-200 rounded-xl p-3 bg-gray-50">
                    <span className="text-xs font-semibold text-gray-400 w-5">{i + 1}.</span>
                    <span className={`flex-1 text-gray-800 ${arabicClass(o.option_text)}`}>{o.option_text}</span>
                    <button onClick={() => moveSequenceItem(i, -1)} disabled={i === 0}
                      className="text-blue-600 disabled:opacity-30 disabled:text-gray-400 px-2 py-1 rounded-lg hover:bg-blue-50 active:scale-95 transition font-bold">↑</button>
                    <button onClick={() => moveSequenceItem(i, 1)} disabled={i === sequenceOrder.length - 1}
                      className="text-blue-600 disabled:opacity-30 disabled:text-gray-400 px-2 py-1 rounded-lg hover:bg-blue-50 active:scale-95 transition font-bold">↓</button>
                  </div>
                ))}
              </div>
              <button onClick={handleSubmitSequence} disabled={timeUp}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed text-white rounded-xl py-4 font-semibold text-lg shadow-md transition active:scale-95">
                {timeUp ? "Time's up" : 'Submit Order'}
              </button>
            </>
          )}
        </div>
      )}

      {(state === 'question' || state === 'buzzer_open') && question && isBuzzerRound && (
        <div className="w-full flex flex-col items-center gap-5">
          <p className={`text-lg font-semibold text-center text-gray-900 ${arabicClass(question.text)}`}>{question.text}</p>
          {questionMedia.length > 0 && (
            <div className={`grid gap-2 ${questionMedia.length > 1 ? 'grid-cols-2' : ''}`}>
              {questionMedia.map((url, i) => (
                <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-72 rounded-xl object-contain" />
              ))}
            </div>
          )}
          {state === 'buzzer_open' ? (
            myBuzz ? (
              (() => {
                const status = buzzOrder.find(b => b.team_id === team?.id)?.status || myBuzz.status;
                const styles: Record<string, string> = {
                  pending: 'bg-orange-50 text-orange-700 border-orange-200',
                  accepted: 'bg-green-50 text-green-700 border-green-200',
                  rejected: 'bg-red-50 text-red-700 border-red-200',
                  correct: 'bg-green-50 text-green-700 border-green-200',
                  wrong: 'bg-red-50 text-red-700 border-red-200',
                };
                const labels: Record<string, string> = {
                  pending: 'Buzzed! Waiting for host…',
                  accepted: '✓ You got it — answer out loud now!',
                  rejected: '✗ Not accepted. Waiting for next team.',
                  correct: '✓ Correct! Nice one.',
                  wrong: '✗ Marked wrong.',
                };
                return (
                  <span className={`rounded-full px-4 py-2 text-base font-semibold border ${styles[status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    {labels[status] || ''}
                  </span>
                );
              })()
            ) : (
              <button onClick={handleBuzz}
                className="w-56 h-56 rounded-full bg-gradient-to-b from-red-500 to-red-700 active:from-red-700 active:to-red-900 border-[10px] border-red-800 shadow-[0_12px_32px_rgba(220,38,38,0.5)] text-white text-3xl font-extrabold tracking-wide transition-transform duration-100 active:scale-95">
                BUZZ!
              </button>
            )
          ) : (
            <span className="rounded-full px-4 py-2 text-sm font-semibold bg-gray-100 text-gray-600 border border-gray-200">Buzzer is closed. Get ready…</span>
          )}
        </div>
      )}

      {state === 'answer_reveal' && (
        <div className="text-center p-6 sm:p-8 bg-white rounded-2xl shadow-lg border border-gray-100 w-full">
          {question && <p className={`text-lg font-semibold text-gray-900 mb-3 ${arabicClass(question.text)}`}>{question.text}</p>}
          {questionMedia.length > 0 && (
            <div className={`grid gap-2 mb-3 ${questionMedia.length > 1 ? 'grid-cols-2' : ''}`}>
              {questionMedia.map((url, i) => (
                <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-64 rounded-xl mx-auto object-contain" />
              ))}
            </div>
          )}
          {/* One branch for both: for an MCQ the stored answer is an option KEY, so a buzzer round
              on an MCQ question used to print a bare "Answer: B" instead of the answer text. */}
          {revealedAnswer && (() => {
            const opt = options.find(o => o.option_key === revealedAnswer);
            const label = opt ? `${String.fromCharCode(65 + options.indexOf(opt))}. ${opt.option_text}` : revealedAnswer;
            return <p className={`text-xl font-bold text-green-700 mb-2 ${arabicClass(label)}`}>Correct answer: {label}</p>;
          })()}
          {revealedSequence && (
            <div className="mb-2">
              <p className="text-lg font-bold text-green-700 mb-1">Correct order:</p>
              <ol className="text-left inline-block">
                {revealedSequence.map((text, i) => <li key={i} dir={arabicDir(text)} className={`text-sm ${arabicClass(text)}`}>{i + 1}. {text}</li>)}
              </ol>
            </div>
          )}
          {submitted && question?.type !== 'SEQUENCE' && (() => {
            const opt = options.find(o => o.option_key === mySelection);
            const label = mySelection ? (opt ? `${String.fromCharCode(65 + options.indexOf(opt))}. ${opt.option_text}` : mySelection) : '—';
            return <p className={`text-sm text-gray-500 mt-2 ${arabicClass(label)}`}>Your answer: {label}</p>;
          })()}
          {submitted && question?.type === 'SEQUENCE' && mySequence && (() => {
            const orderedText = mySequence.map(k => sequenceOrder.find(o => o.option_key === k)?.option_text || k).join(' → ');
            return <p className={`text-sm text-gray-500 mt-2 ${arabicClass(orderedText)}`}>Your order: {orderedText}</p>;
          })()}
        </div>
      )}

      {state === 'rapid_fire' && (
        <div className="w-full flex flex-col items-center gap-5 py-8">
          <span className="rounded-full px-4 py-2 text-sm font-semibold bg-purple-50 text-purple-700 border border-purple-100">
            {team && sessionData?.current_picker_team_id === team.id
              ? "It's your turn!"
              : <span className={arabicClass(pickerTeamName)}>{pickerTeamName || 'Another team'}&apos;s turn</span>}
          </span>
          <div className={`text-8xl font-mono font-extrabold rounded-3xl border-4 px-8 py-4 shadow-sm transition-colors ${
            rapidFireRemaining === null ? 'text-gray-800 border-gray-200' :
            rapidFireRemaining <= 5 ? 'text-red-600 border-red-200 bg-red-50' :
            rapidFireRemaining <= 10 ? 'text-orange-500 border-orange-200 bg-orange-50' :
            'text-green-600 border-green-200 bg-green-50'}`}>
            {rapidFireRemaining ?? '--'}
          </div>
        </div>
      )}

      {state === 'scoreboard' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-gray-100 text-gray-600 border border-gray-200">Scoreboard is on the main screen.</span>
      )}
      {state === 'blank' && (
        <span className="rounded-full px-4 py-2 text-sm font-semibold bg-gray-100 text-gray-600 border border-gray-200">Standby…</span>
      )}
    </div>
  );
}
