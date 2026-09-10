'use client';

import { useState, useEffect, useCallback, useRef, use } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  type LiveSession, type RoundRow, type PickItem,
  startRound, nextQuestion, startTimer, pauseTimer, resetTimer,
  openBuzzer, closeBuzzer, resetBuzzer, decideBuzz, judgeBuzzAnswer,
  gradeAndReveal, setDisplayState, awardManualScore, undoScore,
  eliminateTeam, resetSession, resetCurrentQuestion, resetRound, resetScores,
  fetchPickItems, computeCurrentTierAsync, type TierResult, setCurrentPicker, openCategoryPicks, pickCategory,
  submitAnswer, startRapidFireTurn, fetchSequenceResults, type SequenceResult,
} from '@/lib/liveEngine';
import { fetchScoreboard, type ScoreRow } from '@/lib/scoreboard';
import { questionTypeForRound } from '@/lib/questionSet';
import { arabicClass, arabicDir } from '@/lib/textDir';
import { playBuzzAlert } from '@/lib/buzzSound';
import { questionImages } from '@/lib/media';

type Question = { id: string; text: string; type: string; answer: string; media_url: string | null; media_urls?: string[] | null };
type Option = { option_key: string; option_text: string };
type BuzzerEvent = { id: string; team_id: string; status: string; buzzed_at: string; team_name?: string };
type ScoreLogRow = { id: string; team_id: string; points: number; reason: string | null; created_at: string; team_name?: string };

const RAPID_FIRE_MAX_WRONG = 4;
const RAPID_FIRE_MAX_PASS = 3;

export default function HostPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [correctSequence, setCorrectSequence] = useState<string[]>([]);
  const [seqOptionsByKey, setSeqOptionsByKey] = useState<Record<string, string>>({});
  const [seqSubmittedCount, setSeqSubmittedCount] = useState(0);
  const [seqResults, setSeqResults] = useState<SequenceResult[]>([]);
  const [buzzers, setBuzzers] = useState<BuzzerEvent[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [recentScores, setRecentScores] = useState<ScoreLogRow[]>([]);
  const [timerNow, setTimerNow] = useState(Date.now());
  const [manualPoints, setManualPoints] = useState(10);
  const [manualReason, setManualReason] = useState('');
  const [pickItems, setPickItems] = useState<PickItem[]>([]);
  const [tier, setTier] = useState<TierResult>({ difficulty: null, categories: [], nextItemId: null, done: true });
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null); // who picked this item's category, if a pick round
  const [answerTeamId, setAnswerTeamId] = useState<string | null>(null); // host-chosen answering team, for non-pick rounds
  const [lockedKey, setLockedKey] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);
  const [ignoreTimeoutFor, setIgnoreTimeoutFor] = useState<string | null>(null); // itemId the host said "let them answer anyway" on
  const [rapidCorrect, setRapidCorrect] = useState(0);
  const [rapidWrong, setRapidWrong] = useState(0);
  const [rapidPass, setRapidPass] = useState(0);
  const [rapidLocked, setRapidLocked] = useState(false);
  const prevBuzzCount = useRef(0);

  const round = rounds.find(r => r.id === session?.current_round_id) || null;

  const fetchSession = useCallback(async () => {
    const { data } = await supabase.from('live_sessions').select('*').eq('id', sessionId).single();
    setSession(data);
    return data;
  }, [sessionId]);

  const fetchRounds = useCallback(async (quizId: string) => {
    const { data } = await supabase.from('rounds').select('*').eq('quiz_id', quizId).order('sequence_no');
    setRounds(data || []);
  }, []);

  const fetchQuestion = useCallback(async (itemId: string | null) => {
    if (!itemId) { setQuestion(null); setOptions([]); setPickedTeamId(null); setCorrectSequence([]); setSeqOptionsByKey({}); setSeqSubmittedCount(0); setSeqResults([]); return; }
    const { data: item } = await supabase.from('question_set_items').select('question_id, option_order, picked_by_team_id').eq('id', itemId).single();
    // Clear rather than bail, so an unreadable item can't leave the previous question on screen
    // while the session has already moved on.
    if (!item) { setQuestion(null); setOptions([]); setPickedTeamId(null); setCorrectSequence([]); setSeqOptionsByKey({}); setSeqSubmittedCount(0); setSeqResults([]); return; }
    setPickedTeamId(item.picked_by_team_id || null);
    const { data: q } = await supabase.from('questions').select('id, text, type, answer, media_url, media_urls').eq('id', item.question_id).single();
    setQuestion(q || null);
    // seqResults is intentionally NOT reset here: fetchQuestion re-runs on every realtime tick
    // (any answers/session change calls refreshAll), including while a Sequencing reveal is on
    // screen, and resetting it here raced the dedicated reveal-fetch effect below — it would blank
    // the results and nothing would repopulate them until the item or display_state actually
    // changed. The reveal effect owns clearing/populating seqResults for the item it applies to.
    if (q?.type === 'MCQ') {
      const { data: opts } = await supabase.from('question_options').select('option_key, option_text').eq('question_id', q.id);
      const order: string[] = item.option_order || [];
      const sorted = [...(opts || [])].sort((a, b) => order.indexOf(a.option_key) - order.indexOf(b.option_key));
      setOptions(sorted);
      setCorrectSequence([]);
      setSeqOptionsByKey({});
      setSeqSubmittedCount(0);
    } else if (q?.type === 'SEQUENCE') {
      setOptions([]);
      const { data: opts } = await supabase.from('question_options').select('option_key, option_text, sort_order').eq('question_id', q.id).order('sort_order');
      setCorrectSequence((opts || []).map((o: any) => o.option_text));
      setSeqOptionsByKey(Object.fromEntries((opts || []).map((o: any) => [o.option_key, o.option_text])));
      const { count } = await supabase.from('answers').select('id', { count: 'exact', head: true }).eq('session_id', sessionId).eq('question_set_item_id', itemId);
      setSeqSubmittedCount(count || 0);
    } else {
      setOptions([]);
      setCorrectSequence([]);
      setSeqOptionsByKey({});
      setSeqSubmittedCount(0);
    }
  }, [sessionId]);

  const fetchBuzzers = useCallback(async (itemId: string | null) => {
    if (!itemId) { setBuzzers([]); return; }
    const { data } = await supabase.from('buzzer_events').select('id, team_id, status, buzzed_at, teams(name)').eq('session_id', sessionId).eq('question_set_item_id', itemId).order('buzzed_at');
    const next = (data || []).map((b: any) => ({ ...b, team_name: b.teams?.name }));
    // Side effect outside the state updater — React may invoke an updater more than once, which
    // made the alert sound double up.
    if (next.length > prevBuzzCount.current) playBuzzAlert(); // a new team buzzed in since the last refresh
    prevBuzzCount.current = next.length;
    setBuzzers(next);
  }, [sessionId]);

  const fetchScores = useCallback(async (quizId: string) => {
    const [sb, { data: recent }] = await Promise.all([
      fetchScoreboard(quizId, sessionId),
      supabase.from('scores').select('id, team_id, points, reason, created_at, teams(name)').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10),
    ]);
    setScoreboard(sb);
    setRecentScores((recent || []).map((r: any) => ({ ...r, team_name: r.teams?.name })));
  }, [sessionId]);

  const refreshAll = useCallback(async () => {
    const s = await fetchSession();
    if (!s) return;
    await fetchRounds(s.quiz_id);
    await fetchQuestion(s.current_question_set_item_id);
    await fetchBuzzers(s.current_question_set_item_id);
    await fetchScores(s.quiz_id);
    if (s.current_round_id) {
      const items = await fetchPickItems(s.id, s.current_round_id);
      setPickItems(items);
    } else {
      setPickItems([]);
    }
  }, [fetchSession, fetchRounds, fetchQuestion, fetchBuzzers, fetchScores]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Who got the Sequencing order right, and how fast — fetched once the question is revealed
  // (the grading pass has run by then, so is_correct/awarded_marks are populated). Re-fetches on
  // any answers change while revealed so a late "Reset Question"/re-grade stays in sync.
  useEffect(() => {
    const itemId = session?.current_question_set_item_id;
    if (question?.type !== 'SEQUENCE' || session?.display_state !== 'answer_reveal' || !itemId) {
      setSeqResults([]);
      return;
    }
    let cancelled = false;
    fetchSequenceResults(sessionId, itemId).then(r => { if (!cancelled) setSeqResults(r); });
    return () => { cancelled = true; };
  }, [sessionId, question?.type, session?.display_state, session?.current_question_set_item_id]);

  // Only pick rounds have a category board. This used to run on every realtime event of every
  // round type — including a query per Rapid Fire tap — and two in-flight computations could
  // resolve out of order, leaving nextItemId pointing at a slot that was already filled.
  useEffect(() => {
    if (!round?.team_picks_category || round?.round_type === 'RAPID_FIRE') {
      setTier({ difficulty: null, categories: [], nextItemId: null, done: true });
      return;
    }
    let cancelled = false;
    computeCurrentTierAsync(pickItems, round?.category_ids, questionTypeForRound(round?.round_type || 'MCQ'))
      .then(t => { if (!cancelled) setTier(t); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pickItems, round?.category_ids, round?.round_type, round?.team_picks_category]);

  // Rapid Fire counters are read back from the score rows the buttons write, so a refresh (or a
  // laptop waking up) mid-turn doesn't reset them to zero — which would silently hand the team a
  // fresh allowance of 4 wrongs and 3 passes.
  useEffect(() => {
    const teamId = session?.current_picker_team_id;
    if (round?.round_type !== 'RAPID_FIRE' || !teamId || !round?.id) return;
    let cancelled = false;
    supabase.from('scores').select('reason')
      .eq('session_id', sessionId).eq('round_id', round.id).eq('team_id', teamId)
      .then(({ data }) => {
        if (cancelled) return;
        const rows = data || [];
        setRapidCorrect(rows.filter(r => r.reason === 'Rapid fire correct').length);
        setRapidWrong(rows.filter(r => r.reason === 'Rapid fire wrong').length);
        setRapidPass(rows.filter(r => r.reason === 'Rapid fire pass').length);
      });
    return () => { cancelled = true; };
  }, [sessionId, round?.id, round?.round_type, session?.current_picker_team_id, recentScores]);

  // Whoever is answering the current question: the team that picked its category (pick
  // rounds), or whoever the host selects (non-pick rounds). Reset the pick + fetch whatever
  // answer is already locked in for them whenever the question or the answering team changes.
  useEffect(() => { setAnswerTeamId(null); setIgnoreTimeoutFor(null); }, [session?.current_question_set_item_id]);
  const answeringTeamId = round?.team_picks_category ? pickedTeamId : answerTeamId;

  useEffect(() => {
    const itemId = session?.current_question_set_item_id;
    if (!itemId || !answeringTeamId) { setLockedKey(null); return; }
    // Cancelled on change: a slow response for the PREVIOUS question used to land after the host
    // had already advanced, marking an option as "locked" on a question nobody had answered.
    let cancelled = false;
    supabase.from('answers').select('answer_json').eq('session_id', sessionId).eq('question_set_item_id', itemId).eq('team_id', answeringTeamId).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        // A sequencing answer is stored as { order: [...] } with no `selected` key, so it used to
        // read as "nothing locked in" — and the host's "time's up, mark wrong" button would then
        // overwrite a correct ordering the team had already submitted.
        setLockedKey(data ? (data.answer_json?.selected ?? (data.answer_json?.order ? '__sequence__' : null)) : null);
      });
    return () => { cancelled = true; };
  }, [sessionId, session?.current_question_set_item_id, answeringTeamId]);

  async function handleLockAnswer(key: string) {
    const itemId = session?.current_question_set_item_id;
    if (!itemId || !answeringTeamId || locking || session?.display_state === 'answer_reveal') return;
    setLocking(true);
    const { error } = await submitAnswer(sessionId, itemId, answeringTeamId, key);
    setLocking(false);
    if (error) { alert(error.message || 'Failed to lock that answer.'); return; }
    setLockedKey(key);
    await pauseTimer(sessionId, Math.max(0, timerRemaining() ?? 0)); // stop the clock the moment an answer locks in
  }

  /** Timer ran out with nobody locked in yet — treat it as a wrong/no answer (docks marks_wrong
   * same as a real wrong answer) and go straight to reveal, so the host can move on to the next
   * team's pick. */
  async function handleTimeoutWrong() {
    const itemId = session?.current_question_set_item_id;
    if (!itemId || !answeringTeamId || !round) return;
    setLocking(true);
    const { error } = await submitAnswer(sessionId, itemId, answeringTeamId, '');
    setLocking(false);
    if (error) { alert(error.message || 'Failed to record the timeout.'); return; }
    setLockedKey('');
    await gradeAndReveal(sessionId, itemId, round.id);
  }

  useEffect(() => {
    const sub = supabase.channel(`host:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_sessions', filter: `id=eq.${sessionId}` }, () => refreshAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buzzer_events', filter: `session_id=eq.${sessionId}` }, () => refreshAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores', filter: `session_id=eq.${sessionId}` }, () => refreshAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` }, () => refreshAll())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [sessionId, refreshAll]);

  // tick for timer display
  useEffect(() => {
    const t = setInterval(() => setTimerNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  function timerRemaining(atMs: number = timerNow): number | null {
    const ts = session?.timer_state;
    if (!ts || !round) return null;
    if (ts.paused) return ts.remaining ?? round.timer_seconds;
    if (!ts.startedAt) return null;
    const elapsed = (atMs - new Date(ts.startedAt).getTime()) / 1000;
    // ceil, not round: with round(), a 60s timer displayed 0 at 59.5s — half a second of scoring
    // was still live after the clock read zero.
    return Math.max(0, Math.ceil((ts.duration ?? round.timer_seconds) - elapsed));
  }

  /** Runs an action at most once at a time per key, and surfaces any failure.
   *
   * Every button that writes a score used to fire on each click with no in-flight lock, so a
   * double-tap (very easy on the big Rapid Fire buttons, or on a laggy connection where nothing
   * seems to have happened) inserted the points twice. The `busyRef` check is what actually stops
   * it: React hasn't re-rendered by the time a double-click's second event lands, so a `disabled`
   * prop alone is too slow. Failures now alert instead of silently doing nothing. */
  const busyRef = useRef<Set<string>>(new Set());
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const isBusy = (key: string) => busyKeys.includes(key);

  async function guard(key: string, fn: () => Promise<void>, failMessage = 'That action failed.') {
    if (busyRef.current.has(key)) return false;
    busyRef.current.add(key);
    setBusyKeys(k => [...k, key]);
    try {
      await fn();
      return true;
    } catch (e: unknown) {
      alert(`${failMessage}\n\n${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      busyRef.current.delete(key);
      setBusyKeys(k => k.filter(x => x !== key));
    }
  }

  async function handleStartRound(roundId: string) {
    // Clicking the round that's already running silently wipes the current question, the timer
    // and the picking team — easy to do by accident when glancing at the round list mid-round.
    if (roundId === round?.id && !confirm(`Restart "${round.name}"? The current question and timer will be cleared.`)) return;
    await guard(`round:${roundId}`, () => startRound(sessionId, roundId), 'Failed to start that round.');
  }

  async function handleRapidFireSelectTeam(teamId: string | null) {
    if (!teamId || !session) return;
    const prev = session.current_picker_team_id;
    // Optimistic, so a Correct/Wrong tapped immediately after switching teams can't still be
    // read against the PREVIOUS team while the realtime update is in flight.
    setSession(s => (s ? { ...s, current_picker_team_id: teamId, timer_state: {} } : s));
    setRapidCorrect(0);
    setRapidWrong(0);
    setRapidPass(0);
    setRapidLocked(false);
    const ok = await guard(`rapid-team`, () => startRapidFireTurn(sessionId, teamId), 'Failed to switch the rapid-fire team.');
    if (!ok) setSession(s => (s ? { ...s, current_picker_team_id: prev } : s));
  }

  async function handleRapidFireStop() {
    setRapidLocked(true); // lock the buttons immediately, don't wait for the DB round-trip
    await pauseTimer(sessionId, 0);
  }

  /** True only while this turn can still be scored. Re-reads the clock live rather than trusting
   * the 250ms render tick, so a click landing just after time expires can't still score. */
  function rapidFireOpen() {
    return !rapidLocked && (timerRemaining(Date.now()) ?? 0) > 0 && !!session?.current_picker_team_id;
  }

  async function handleRapidFireCorrect() {
    if (!round || !session?.current_picker_team_id || !rapidFireOpen()) return;
    const teamId = session.current_picker_team_id;
    await guard('rapid-score', async () => {
      await awardManualScore(sessionId, teamId, round.id, 10, 'Rapid fire correct');
      setRapidCorrect(c => c + 1);
    }, 'The point was NOT recorded.');
  }

  async function handleRapidFireWrong() {
    if (!round || !session?.current_picker_team_id || !rapidFireOpen()) return;
    const teamId = session.current_picker_team_id;
    const next = rapidWrong + 1;
    if (next >= RAPID_FIRE_MAX_WRONG) setRapidLocked(true); // lock before awaiting the network
    await guard('rapid-score', async () => {
      await awardManualScore(sessionId, teamId, round.id, -5, 'Rapid fire wrong');
      setRapidWrong(next);
    }, 'The penalty was NOT recorded.');
    if (next >= RAPID_FIRE_MAX_WRONG) await handleRapidFireStop();
  }

  async function handleRapidFirePass() {
    if (!round || !session?.current_picker_team_id || !rapidFireOpen()) return;
    const teamId = session.current_picker_team_id;
    const next = rapidPass + 1;
    if (next >= RAPID_FIRE_MAX_PASS) setRapidLocked(true);
    await guard('rapid-score', async () => {
      await awardManualScore(sessionId, teamId, round.id, 0, 'Rapid fire pass');
      setRapidPass(next);
    }, 'The pass was NOT recorded.');
    if (next >= RAPID_FIRE_MAX_PASS) await handleRapidFireStop();
  }

  async function handleShowFirstOrNext() {
    if (!session || !round) return;
    await guard('next-question', async () => {
      const res = await nextQuestion(sessionId, round.id, session.current_question_set_item_id);
      // Otherwise "nothing happened" looks identical to a failed click.
      if (res?.done) alert(`No more questions in "${round.name}".`);
    }, 'Failed to move to the next question.');
  }

  async function handleAward(teamId: string, points: number, reason: string) {
    await guard(`award:${teamId}`, () => awardManualScore(sessionId, teamId, session?.current_round_id || null, points, reason), 'The score was NOT recorded.');
  }

  async function handleEliminate(teamId: string) {
    await guard(`elim:${teamId}`, () => eliminateTeam(sessionId, teamId, session?.current_round_id || null, `Eliminated after ${round?.name || 'round'}`), 'Failed to eliminate that team.');
  }

  async function handleNextTeamPicker() {
    if (activeTeams.length === 0) return;
    const sortedTeams = [...activeTeams].sort((a, b) => a.name.localeCompare(b.name));
    const currentIdx = sortedTeams.findIndex(t => t.team_id === session?.current_picker_team_id);
    const next = sortedTeams[(currentIdx + 1) % sortedTeams.length];
    await handleSetPicker(next.team_id);
  }

  async function handleSetPicker(teamId: string | null) {
    if (!session) return;
    const prev = session.current_picker_team_id;
    setSession({ ...session, current_picker_team_id: teamId }); // optimistic — don't wait on realtime round-trip
    try {
      await setCurrentPicker(sessionId, teamId);
    } catch (e: any) {
      setSession(s => (s ? { ...s, current_picker_team_id: prev } : s));
      alert(e.message || 'Failed to set the picking team.');
    }
  }

  async function handlePick(categoryId: string) {
    if (!session?.current_picker_team_id || !tier.nextItemId) return;
    try {
      await pickCategory(sessionId, tier.nextItemId, session.current_picker_team_id, categoryId);
    } catch (e: any) {
      alert(e.message || 'Failed to pick that category.');
    }
  }

  const remaining = timerRemaining();
  const rapidFireActive = remaining !== null && remaining > 0 && !rapidLocked;
  const activeTeams = scoreboard.filter(t => !t.eliminated);
  const pickerTeam = activeTeams.find(t => t.team_id === session?.current_picker_team_id);

  if (!session) return <p className="text-gray-400">Loading session…</p>;

  return (
    <div className="flex flex-col gap-6 bg-gradient-to-b from-gray-900 to-gray-950 min-h-screen p-6 -m-6">
      <div className="flex items-center justify-between bg-gray-800/60 backdrop-blur border border-gray-700 rounded-2xl shadow-xl p-4">
        <div>
          <h2 className="text-xl font-bold text-white">Live Session</h2>
          <p className="text-sm text-gray-400">
            Status: <span className="font-semibold text-gray-200">{session.status}</span>
            {round ? <> · <span className="text-blue-400">{round.name}</span></> : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {/* These three sit side by side and none of them can be undone, so each one asks first. */}
          {round && (
            <button
              onClick={() => { if (confirm(`Reset "${round.name}"?\n\nThis deletes the round's answers, buzzes and scores.`)) guard('reset-round', () => resetRound(sessionId, round.id), 'Reset round failed.'); }}
              disabled={isBusy('reset-round')}
              className="border border-amber-500/60 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-medium">Reset Round</button>
          )}
          <button
            onClick={() => { if (confirm('Delete ALL scores for this session?\n\nThis cannot be undone.')) guard('reset-scores', () => resetScores(sessionId), 'Reset scores failed.'); }}
            disabled={isBusy('reset-scores')}
            className="border border-amber-500/60 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-medium">Reset Scores</button>
          <button
            onClick={() => { if (confirm('Reset the whole session?\n\nAnswers, buzzes and category picks are deleted and the session returns to not-started. Scores are kept — use Reset Scores for those.')) guard('reset-session', () => resetSession(sessionId), 'Reset session failed.'); }}
            disabled={isBusy('reset-session')}
            className="border border-red-500/60 text-red-400 hover:bg-red-500/10 hover:border-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-medium">Reset Session</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Round selector */}
        <div className="bg-gray-800/60 backdrop-blur border border-gray-700 rounded-2xl shadow-xl p-4">
          <h3 className="text-lg font-bold text-white mb-3">Rounds</h3>
          <ul className="flex flex-col gap-1.5">
            {rounds.map(r => (
              <li key={r.id}>
                <button onClick={() => handleStartRound(r.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-all ${r.id === round?.id ? 'bg-blue-600 text-white shadow-md shadow-blue-900/50' : 'bg-gray-700/60 text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
                  R{r.sequence_no}. {r.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Current question + controls */}
        <div className="bg-gray-800/60 backdrop-blur border border-gray-700 rounded-2xl shadow-xl p-4 col-span-2">
          <h3 className="text-lg font-bold text-white mb-3">Question Control</h3>
          {round?.round_type === 'RAPID_FIRE' ? (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-gray-400">Team up:</span>
                <select value={session.current_picker_team_id || ''} onChange={e => handleRapidFireSelectTeam(e.target.value || null)}
                  className="bg-gray-900 border border-gray-600 rounded-lg p-1.5 text-sm text-gray-200">
                  <option value="">— choose team —</option>
                  {activeTeams.map(t => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-3 mb-3">
                <button onClick={() => { setRapidLocked(false); startTimer(sessionId, round.timer_seconds || 60); }} disabled={!session.current_picker_team_id}
                  className="bg-[#10b981] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-md">
                  Start Timer ({round.timer_seconds || 60}s)
                </button>
                <button onClick={handleRapidFireStop} disabled={!rapidFireActive}
                  className="bg-[#f59e0b] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-md">
                  Stop Timer
                </button>
                <span className="px-5 py-2 bg-black border border-gray-700 rounded-xl text-2xl font-mono text-white tabular-nums shadow-inner">{remaining ?? '--'}s</span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={handleRapidFireCorrect} disabled={!rapidFireActive || isBusy('rapid-score')}
                  className="bg-[#10b981] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-6 py-3 rounded-xl text-lg font-bold text-white shadow-lg">
                  ✓ Correct (+10)
                </button>
                <button onClick={handleRapidFireWrong} disabled={!rapidFireActive || isBusy('rapid-score')}
                  className="bg-[#ef4444] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-6 py-3 rounded-xl text-lg font-bold text-white shadow-lg">
                  ✗ Wrong (-5)
                </button>
                <button onClick={handleRapidFirePass} disabled={!rapidFireActive || isBusy('rapid-score')}
                  className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-6 py-3 rounded-xl text-lg font-bold text-white shadow-lg">
                  ⤼ Pass
                </button>
                <span className="text-sm text-gray-400 ml-2">
                  This turn: <span className="text-emerald-400 font-semibold">{rapidCorrect} correct</span>, <span className="text-red-400 font-semibold">{rapidWrong} wrong</span>, <span className="text-gray-300 font-semibold">{rapidPass} pass{rapidPass === 1 ? '' : 'es'}</span>
                  <span className="text-gray-500"> ({rapidCorrect + rapidWrong + rapidPass} asked)</span>
                </span>
              </div>
              {!rapidFireActive && (remaining === 0 || rapidLocked) && session.current_picker_team_id && (
                <p className="text-xs text-amber-400 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                  {rapidWrong >= RAPID_FIRE_MAX_WRONG || rapidPass >= RAPID_FIRE_MAX_PASS
                    ? `Round-ending limit reached (${RAPID_FIRE_MAX_WRONG} wrong or ${RAPID_FIRE_MAX_PASS} passes) — timer stopped automatically.`
                    : "Time's up — Correct/Wrong/Pass are locked."} Pick the next team to continue.
                </p>
              )}
            </div>
          ) : question ? (
            <div className="mb-4">
              <p className={`text-lg font-semibold text-white ${arabicClass(question.text)}`}>{question.text}</p>
              {questionImages(question).length > 0 && (
                <div className={`grid gap-2 mt-2 mb-2 ${questionImages(question).length > 1 ? 'grid-cols-2 max-w-md' : ''}`}>
                  {questionImages(question).map((url, i) => (
                    <img key={url} src={url} alt={`Question image ${i + 1}`} className="max-h-64 rounded-xl border border-gray-600 object-contain" />
                  ))}
                </div>
              )}
              {question.type === 'PICTURE' && question.answer && (
                <p className="text-sm text-amber-400 mt-1">Reference answer (host only): {question.answer}</p>
              )}
              {question.type === 'SEQUENCE' && (
                <div className="mt-1 mb-1">
                  <p className={`text-sm text-amber-400 ${arabicClass(correctSequence.join(' '))}`}>Correct order (host only): {correctSequence.join(' → ')}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {seqSubmittedCount} of {activeTeams.length} team{activeTeams.length === 1 ? '' : 's'} submitted
                  </p>
                </div>
              )}

              {/* Every team's submitted order once revealed, fastest correct team first. Completion
                  time is measured from when the host started the timer for this question (the same
                  server clock the buzzer uses), so it lines up with what the Display screen shows. */}
              {question.type === 'SEQUENCE' && session.display_state === 'answer_reveal' && seqResults.length > 0 && (
                <div className="mt-3 mb-1">
                  <h4 className="text-sm font-bold text-gray-300 mb-2">Team Results — fastest correct first</h4>
                  <ul className="flex flex-col gap-1.5">
                    {[...seqResults]
                      .sort((a, b) => {
                        if (!!a.is_correct !== !!b.is_correct) return a.is_correct ? -1 : 1;
                        return new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime();
                      })
                      .map((r, i) => {
                        const startedAt = (session.timer_state as { startedAt?: string } | null)?.startedAt;
                        const elapsed = startedAt
                          ? Math.max(0, (new Date(r.submitted_at).getTime() - new Date(startedAt).getTime()) / 1000)
                          : null;
                        const orderText = r.order.map(k => seqOptionsByKey[k] || k).join(' → ');
                        return (
                          <li key={r.team_id} className="flex items-center justify-between gap-3 bg-gray-700/60 border border-gray-600 rounded-lg px-3 py-1.5 text-sm">
                            <span className="min-w-0">
                              <span className={arabicClass(r.team_name)}>
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 text-xs font-bold text-gray-300 mr-1.5 align-middle">{i + 1}</span>
                                <span className="text-gray-100">{r.team_name}</span>
                                {' — '}
                                <span className={r.is_correct ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
                                  {r.is_correct ? '✓ Correct' : '✗ Wrong'}
                                </span>
                              </span>
                              <p className={`text-xs text-gray-400 mt-0.5 truncate ${arabicClass(orderText)}`}>{orderText}</p>
                            </span>
                            <span className="text-gray-300 font-mono text-xs shrink-0">{elapsed !== null ? `${elapsed.toFixed(1)}s` : '—'}</span>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}

              {!round?.team_picks_category && options.length > 0 && session.display_state !== 'answer_reveal' && (
                <div className="flex items-center gap-2 mt-2 mb-1">
                  <span className="text-sm text-gray-400">Team answering:</span>
                  <select value={answerTeamId || ''} onChange={e => setAnswerTeamId(e.target.value || null)}
                    className="bg-gray-900 border border-gray-600 rounded-lg p-1.5 text-sm text-gray-200">
                    <option value="">— choose team —</option>
                    {activeTeams.map(t => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              {round?.team_picks_category && session.display_state !== 'answer_reveal' && (
                <p className="text-xs text-gray-400 mt-2 mb-1">
                  Answering: <b className="text-gray-200">{activeTeams.find(t => t.team_id === pickedTeamId)?.name || '—'}</b> (picked this category)
                </p>
              )}

              {session.display_state === 'question' && remaining === 0 && lockedKey === null && answeringTeamId && ignoreTimeoutFor !== session.current_question_set_item_id && (
                <div className="mt-2 mb-1 bg-red-950/60 border border-red-700 rounded-xl p-3 flex items-center justify-between gap-3">
                  <span className="text-red-300 text-sm font-medium">⏰ Time&apos;s up — no answer locked yet.</span>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={handleTimeoutWrong} disabled={locking}
                      className="bg-[#ef4444] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-xs font-semibold text-white">
                      Mark Wrong &amp; Reveal
                    </button>
                    <button onClick={() => setIgnoreTimeoutFor(session.current_question_set_item_id)}
                      className="bg-gray-700 hover:bg-gray-600 transition-all px-3 py-1.5 rounded-lg text-xs font-medium text-gray-200">
                      Let Team Answer Anyway
                    </button>
                  </div>
                </div>
              )}

              {options.length > 0 && (
                <ul className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  {options.map((o, i) => {
                    const isLocked = lockedKey === o.option_key;
                    const isCorrect = session.display_state === 'answer_reveal' && o.option_key === question.answer;
                    const clickable = session.display_state !== 'answer_reveal' && !!answeringTeamId;
                    return (
                      <li key={o.option_key}>
                        <button
                          onClick={() => clickable && handleLockAnswer(o.option_key)}
                          disabled={!clickable || locking}
                          className={`w-full text-left p-2 rounded-lg border transition-all text-sm ${
                            isCorrect ? 'border-[#10b981] bg-emerald-950/60 text-emerald-200'
                              : isLocked ? 'border-[#2563eb] bg-blue-950/60 text-blue-200'
                              : 'border-gray-600 text-gray-200'
                          } ${clickable ? 'hover:bg-gray-700 cursor-pointer' : ''} disabled:cursor-default disabled:opacity-70`}>
                          <span dir={arabicDir(o.option_text)} className={arabicClass(o.option_text)}>{String.fromCharCode(65 + i)}. {o.option_text}</span> {isLocked && session.display_state !== 'answer_reveal' ? ' ✓ locked' : ''}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {options.length > 0 && session.display_state !== 'answer_reveal' && !answeringTeamId && (
                <p className="text-xs text-amber-400 mt-2">Choose the answering team above before locking an answer.</p>
              )}
              {question.type === 'MCQ' && session.display_state !== 'answer_reveal' && (
                <p className="text-xs text-gray-500 mt-2">Correct answer (host only): {question.answer}</p>
              )}
            </div>
          ) : (
            <p className="text-gray-400 mb-4">No question shown yet.</p>
          )}

          {round?.round_type !== 'RAPID_FIRE' && round?.team_picks_category && (session.display_state === 'category_pick' || (!question && !tier.done)) && (
            <div className="mb-4 bg-gray-900/70 border border-gray-700 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-gray-400">Picking now:</span>
                <select value={session.current_picker_team_id || ''} onChange={e => handleSetPicker(e.target.value || null)}
                  className="bg-gray-800 border border-gray-600 rounded-lg p-1.5 text-sm text-gray-200">
                  <option value="">— choose team —</option>
                  {activeTeams.map(t => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
                </select>
                <button onClick={handleNextTeamPicker} className="bg-gray-700 hover:bg-gray-600 transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-gray-200">Next Team ▶</button>
              </div>
              {tier.done ? (
                <p className="text-gray-400 text-sm">All categories in this round have been picked.</p>
              ) : (
                <>
                  <p className="text-xs text-gray-400 mb-2">Difficulty: <b className="text-gray-200">{tier.difficulty}</b> — {pickerTeam ? `${pickerTeam.name}'s turn` : 'select a team above'}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {tier.categories.map(c => (
                      <button key={c.category_id} onClick={() => handlePick(c.category_id)} disabled={!session.current_picker_team_id}
                        className={`bg-[#2563eb] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all rounded-lg p-3 text-sm font-semibold text-white shadow-md ${arabicClass(c.category_name)}`}>
                        {c.category_name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-4">
            {round?.round_type === 'RAPID_FIRE' ? null : round?.team_picks_category ? (
              !question && (
                <button onClick={() => openCategoryPicks(sessionId)} className="bg-[#2563eb] hover:brightness-110 transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">
                  Open Category Picks
                </button>
              )
            ) : (
              <button onClick={handleShowFirstOrNext} disabled={!round} className="bg-[#2563eb] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">
                {question ? 'Next Question' : 'Show First Question'}
              </button>
            )}
            {round?.team_picks_category && question && session.display_state === 'answer_reveal' && (
              <button onClick={() => openCategoryPicks(sessionId)} className="bg-[#2563eb] hover:brightness-110 transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">
                Back to Category Picks
              </button>
            )}
            {round?.round_type !== 'RAPID_FIRE' && round?.round_type !== 'BUZZER' && round?.round_type !== 'PICTURE_BUZZER' && round?.timer_seconds ? (
              <>
                <button onClick={() => startTimer(sessionId, round.timer_seconds)} className="bg-[#10b981] hover:brightness-110 transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">Start Timer</button>
                {/* Disabled with no timer running: pausing "nothing" used to write remaining: 0,
                    which made the display read 0s and trip the "time's up" banner on a timer
                    that had never been started. */}
                <button onClick={() => remaining !== null && pauseTimer(sessionId, remaining)} disabled={remaining === null}
                  className="bg-[#f59e0b] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">Pause Timer</button>
                <button onClick={() => resetTimer(sessionId)} className="bg-gray-600 hover:bg-gray-500 transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">Reset Timer</button>
                <span className="px-3 py-1.5 bg-black border border-gray-700 rounded-lg text-sm font-mono text-white tabular-nums">{remaining ?? '--'}s</span>
              </>
            ) : null}
            {question && (
              <>
                {/* Disabled once revealed: this scores every team, so clicking it a second time
                    used to award everyone twice for the same question. */}
                <button
                  onClick={() => guard('reveal', () => gradeAndReveal(sessionId, session.current_question_set_item_id!, session.current_round_id!), 'Reveal & score failed.')}
                  disabled={isBusy('reveal') || session.display_state === 'answer_reveal'}
                  className="bg-[#7c3aed] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">
                  {session.display_state === 'answer_reveal' ? 'Answer Revealed' : 'Reveal Answer & Score'}
                </button>
                <button
                  onClick={() => { if (confirm('Reset this question? Answers, buzzes and the points awarded for it are deleted so it can be re-run.')) guard('reset-q', () => resetCurrentQuestion(sessionId, session.current_question_set_item_id!), 'Reset question failed.'); }}
                  disabled={isBusy('reset-q')}
                  className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">Reset Question</button>
              </>
            )}
            {round?.buzzer_enabled && question && (
              <>
                <button onClick={() => openBuzzer(sessionId, session.current_question_set_item_id)} className="bg-[#ef4444] hover:brightness-110 transition-all px-3 py-1.5 rounded-lg text-sm font-semibold text-white shadow-md">Open Buzzer</button>
                <button onClick={() => closeBuzzer(sessionId)} className="bg-gray-600 hover:bg-gray-500 transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">Close Buzzer</button>
                <button onClick={() => guard('reset-buzz', () => resetBuzzer(sessionId, session.current_question_set_item_id!), 'Reset buzzer failed.')} disabled={isBusy('reset-buzz')}
                  className="bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">Reset Buzzer</button>
              </>
            )}
            <button onClick={() => setDisplayState(sessionId, session.display_state === 'scoreboard' ? 'question' : 'scoreboard')} className="bg-slate-600 hover:bg-slate-500 transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">
              {session.display_state === 'scoreboard' ? 'Hide Scoreboard' : 'Show Scoreboard'}
            </button>
            <button onClick={() => setDisplayState(sessionId, 'blank')} className="bg-black border border-gray-600 hover:bg-gray-900 transition-all px-3 py-1.5 rounded-lg text-sm font-medium text-white">Blank Display</button>
          </div>

          {round?.buzzer_enabled && (
            <div className="mb-2">
              <h4 className="text-sm font-bold text-gray-300 mb-2">Buzzer Activity</h4>
              {buzzers.length === 0 ? <p className="text-gray-500 text-sm">No buzzes yet.</p> : (
                <ul className="flex flex-col gap-1.5">
                  {buzzers.map((b, i) => (
                    <li key={b.id} className="flex items-center justify-between bg-gray-700/60 border border-gray-600 rounded-lg px-3 py-1.5 text-sm">
                      <span className={arabicClass(b.team_name)}>
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 text-xs font-bold text-gray-300 mr-1.5 align-middle">{i + 1}</span>
                        <span className="text-gray-100">{b.team_name}</span>
                        {' — '}
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          b.status === 'pending' ? 'bg-amber-900/60 text-amber-300'
                            : b.status === 'accepted' ? 'bg-blue-900/60 text-blue-300'
                            : b.status === 'correct' ? 'bg-emerald-900/60 text-emerald-300'
                            : 'bg-red-900/60 text-red-300'
                        }`}>{b.status}</span>
                      </span>
                      {b.status === 'pending' && (
                        <span className="flex gap-3">
                          <button onClick={() => guard(`buzz:${b.id}`, () => decideBuzz(sessionId, b.id, b.team_id, round.id, 'accepted'), 'Failed to accept that buzz.')} disabled={isBusy(`buzz:${b.id}`)} className="text-emerald-400 hover:text-emerald-300 font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">Let Them Answer</button>
                          <button onClick={() => guard(`buzz:${b.id}`, () => decideBuzz(sessionId, b.id, b.team_id, round.id, 'rejected'), 'Failed to reject that buzz.')} disabled={isBusy(`buzz:${b.id}`)} className="text-red-400 hover:text-red-300 font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">Reject (false start)</button>
                        </span>
                      )}
                      {b.status === 'accepted' && (
                        <span className="flex items-center gap-3">
                          <span className="text-amber-400 text-xs font-medium">Answering out loud —</span>
                          <button onClick={() => guard(`buzz:${b.id}`, () => judgeBuzzAnswer(sessionId, b.id, b.team_id, round.id, true, round.marks_correct, round.marks_wrong, session.current_question_set_item_id), 'The score was NOT recorded.')} disabled={isBusy(`buzz:${b.id}`)} className="text-emerald-400 hover:text-emerald-300 font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">✓ Correct</button>
                          <button onClick={() => guard(`buzz:${b.id}`, () => judgeBuzzAnswer(sessionId, b.id, b.team_id, round.id, false, round.marks_correct, round.marks_wrong, session.current_question_set_item_id), 'The penalty was NOT recorded.')} disabled={isBusy(`buzz:${b.id}`)} className="text-red-400 hover:text-red-300 font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">✗ Wrong</button>
                        </span>
                      )}
                      {(b.status === 'correct' || b.status === 'wrong') && (
                        <span className="text-xs text-gray-500">judged — use Reset Buzzer to re-judge</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Scoring console */}
        <div className="bg-gray-800/60 backdrop-blur border border-gray-700 rounded-2xl shadow-xl p-4">
          <h3 className="text-lg font-bold text-white mb-3">Scoring Console</h3>
          <div className="flex gap-2 mb-3">
            <input type="number" value={manualPoints} onChange={e => setManualPoints(Number(e.target.value))} className="w-20 bg-gray-900 border border-gray-600 rounded-lg p-1.5 text-sm text-gray-200" />
            <input placeholder="Reason (optional)" value={manualReason} onChange={e => setManualReason(e.target.value)} className="flex-1 bg-gray-900 border border-gray-600 rounded-lg p-1.5 text-sm text-gray-200" />
          </div>
          <ul className="flex flex-col gap-1.5 mb-4">
            {activeTeams.map(t => (
              <li key={t.team_id} className="flex items-center justify-between bg-gray-700/60 border border-gray-600 rounded-lg px-3 py-1.5 text-sm">
                <span className={arabicClass(t.name)}>
                  <span className="text-gray-100 font-medium">{t.name}</span>{' '}
                  <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-900 text-gray-300">{t.total} pts</span>
                </span>
                <span className="flex gap-3">
                  <button onClick={() => handleAward(t.team_id, manualPoints, manualReason || 'Manual award')} disabled={isBusy(`award:${t.team_id}`)} className="text-emerald-400 hover:text-emerald-300 font-semibold hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">+{manualPoints}</button>
                  <button onClick={() => handleAward(t.team_id, -manualPoints, manualReason || 'Manual deduction')} disabled={isBusy(`award:${t.team_id}`)} className="text-red-400 hover:text-red-300 font-semibold hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">-{manualPoints}</button>
                  {round?.elimination_enabled && <button onClick={() => { if (confirm(`Eliminate ${t.name}?`)) handleEliminate(t.team_id); }} disabled={isBusy(`elim:${t.team_id}`)} className="text-orange-400 hover:text-orange-300 font-semibold hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">Eliminate</button>}
                </span>
              </li>
            ))}
          </ul>
          <h4 className="text-sm font-bold text-gray-300 mb-2">Recent Transactions</h4>
          <ul className="flex flex-col gap-1.5 text-xs text-gray-400">
            {recentScores.map(s => (
              <li key={s.id} className="flex items-center justify-between">
                <span className={arabicClass(s.team_name)}>
                  <span className="text-gray-300 font-medium">{s.team_name}</span>: <span className={s.points > 0 ? 'text-emerald-400 font-semibold' : s.points < 0 ? 'text-red-400 font-semibold' : ''}>{s.points > 0 ? '+' : ''}{s.points}</span> ({s.reason})
                </span>
                <button onClick={() => guard(`undo:${s.id}`, () => undoScore(s), 'Undo failed.')} disabled={isBusy(`undo:${s.id}`)} className="text-blue-400 hover:text-blue-300 font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed transition-all">Undo</button>
              </li>
            ))}
          </ul>
        </div>

        {/* Scoreboard */}
        <div className="bg-gray-800/60 backdrop-blur border border-gray-700 rounded-2xl shadow-xl p-4">
          <h3 className="text-lg font-bold text-white mb-3">Scoreboard</h3>
          <ol className="flex flex-col gap-1.5">
            {scoreboard.map(t => (
              <li key={t.team_id} className={`flex justify-between items-center px-3 py-1.5 rounded-lg text-sm border ${t.eliminated ? 'bg-gray-900/60 border-gray-800 text-gray-500 line-through' : 'bg-gray-700/60 border-gray-600 text-gray-100'}`}>
                <span className={arabicClass(t.name)}>
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-xs font-bold text-gray-300 mr-2 align-middle">{t.rank}</span>
                  {t.name}
                </span>
                <span className="font-semibold">{t.total} pts</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
