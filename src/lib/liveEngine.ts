import { supabase } from './supabaseClient';
import { DIFFICULTY_ORDER, questionTypeForRound } from './questionSet';

// ---- shared types ----
export type LiveSession = {
  id: string;
  quiz_id: string;
  status: string;
  current_round_id: string | null;
  current_question_set_item_id: string | null;
  current_picker_team_id: string | null;
  display_state: string;
  timer_state: any;
  started_at: string | null;
  ended_at: string | null;
  winner_team_id?: string | null;
};

export type RoundRow = {
  id: string; quiz_id: string; sequence_no: number; name: string; round_type: string;
  question_count: number; marks_correct: number; marks_wrong: number; marks_skip: number;
  timer_seconds: number; buzzer_enabled: boolean; elimination_enabled: boolean; elimination_count: number;
  team_picks_category: boolean; category_ids: string[] | null;
};

export type PickItem = {
  id: string;
  category_id: string | null;
  category_name?: string;
  question_id: string | null;
  difficulty: string;
  display_order: number;
  picked_by_team_id: string | null;
};

async function logEvent(sessionId: string, eventType: string, payload: Record<string, unknown> = {}) {
  await supabase.from('live_events').insert({ session_id: sessionId, event_type: eventType, payload_json: payload });
}

/** A running timer_state for `seconds`, or {} (no timer) if the round has no timer configured —
 * used so the countdown starts the instant a question appears, instead of a separate manual click. */
function autoStartTimerState(seconds: number | null | undefined) {
  return seconds && seconds > 0 ? { duration: seconds, startedAt: new Date().toISOString(), paused: false, remaining: null } : {};
}

// ---- round progression ----
export async function startRound(sessionId: string, roundId: string) {
  const { data: round } = await supabase.from('rounds').select('team_picks_category').eq('id', roundId).single();
  // Team-picks-category rounds go straight to team picking — Team/Display only show that
  // screen once display_state is 'category_pick', so without this they'd sit on the round
  // intro screen until the host separately clicked "Open Category Picks."
  await supabase.from('live_sessions').update({
    current_round_id: roundId, current_question_set_item_id: null,
    display_state: round?.team_picks_category ? 'category_pick' : 'round_intro',
    current_picker_team_id: null, timer_state: {},
    status: 'live', started_at: new Date().toISOString(),
  }).eq('id', sessionId);
  await logEvent(sessionId, 'round_started', { roundId });
}

export async function getOrderedItems(sessionId: string, roundId: string) {
  const { data: set } = await supabase.from('question_sets').select('id').eq('session_id', sessionId).eq('round_id', roundId).maybeSingle();
  if (!set) return [];
  const { data: items } = await supabase.from('question_set_items').select('*').eq('question_set_id', set.id).order('display_order');
  return items || [];
}

export async function nextQuestion(sessionId: string, roundId: string, currentItemId: string | null) {
  const items = await getOrderedItems(sessionId, roundId);
  // Persisted, not just a one-time alert: `round_complete` is a real display_state, so the Host
  // and Display screens both show it on their own — even after a refresh, even if nobody was
  // looking at the moment the last question was answered — instead of leaving the last question
  // sitting on screen looking as if the round were still live.
  if (items.length === 0 || (currentItemId && items.findIndex(i => i.id === currentItemId) + 1 >= items.length)) {
    await supabase.from('live_sessions').update({ display_state: 'round_complete' }).eq('id', sessionId);
    await logEvent(sessionId, 'round_complete', { roundId });
    return { done: true };
  }
  const idx = currentItemId ? items.findIndex(i => i.id === currentItemId) : -1;
  const next = items[idx + 1];
  const { data: round } = await supabase.from('rounds').select('timer_seconds').eq('id', roundId).single();
  await supabase.from('live_sessions').update({
    current_question_set_item_id: next.id, display_state: 'question',
    timer_state: autoStartTimerState(round?.timer_seconds),
  }).eq('id', sessionId);
  await logEvent(sessionId, 'next_question', { itemId: next.id });
  return { done: false, itemId: next.id as string };
}

// ---- team-picks-category mode ----
// The admin only sets, per round, how many question "slots" are needed at each difficulty tier
// (Easy first, then Medium, then Hard). Slots start with no category/question assigned. At play
// time, whichever team's turn it is freely picks a category from whatever still has an
// unused question at the current tier — the category is NOT pre-decided by the admin. Picking
// assigns a random not-yet-used question from that category+tier to the slot and reveals it.

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function fetchPickItems(sessionId: string, roundId: string): Promise<PickItem[]> {
  const { data: set } = await supabase.from('question_sets').select('id').eq('session_id', sessionId).eq('round_id', roundId).maybeSingle();
  if (!set) return [];
  const { data: items } = await supabase
    .from('question_set_items')
    .select('id, category_id, question_id, difficulty, display_order, picked_by_team_id, categories(name)')
    .eq('question_set_id', set.id)
    .order('display_order');
  return (items || []).map((i: any) => ({
    id: i.id, category_id: i.category_id, category_name: i.categories?.name, question_id: i.question_id,
    difficulty: i.difficulty, display_order: i.display_order, picked_by_team_id: i.picked_by_team_id,
  }));
}

export type TierResult = {
  difficulty: string | null;
  categories: { category_id: string; category_name: string }[];
  nextItemId: string | null;
  done: boolean;
};

/** The current tier is the earliest difficulty block (in DIFFICULTY_ORDER) that still has an
 * unpicked slot. Returns every category that still has at least one active question at that
 * difficulty which hasn't already been used elsewhere in this round's set — i.e. every category
 * genuinely pickable right now — plus the id of a free slot to fill when a pick is made.
 * allowedCategoryIds restricts the pickable set to the round's chosen categories (the admin's
 * per-round category assignment); null/empty means every category is fair game. */
export async function computeCurrentTierAsync(items: PickItem[], allowedCategoryIds?: string[] | null, questionType: string = 'MCQ'): Promise<TierResult> {
  if (items.length === 0) return { difficulty: null, categories: [], nextItemId: null, done: true };
  const tiersPresent = [...new Set(items.map(i => i.difficulty))];
  const extra = tiersPresent.filter(d => !DIFFICULTY_ORDER.includes(d)).sort();
  const order = [...DIFFICULTY_ORDER.filter(d => tiersPresent.includes(d)), ...extra];

  const usedQuestionIds = new Set(items.filter(i => i.question_id).map(i => i.question_id as string));

  for (const difficulty of order) {
    const unpicked = items.filter(i => i.difficulty === difficulty && !i.picked_by_team_id);
    if (unpicked.length === 0) continue;
    // .eq('type', ...) matters: without it a SEQUENCING or PICTURE round with "teams pick
    // category" offered categories whose only questions were plain text MCQs, and then served
    // one — an unplayable question mid-show. .range() matters for the same reason it did on the
    // scoreboard: Supabase caps an unbounded select at 1000 rows, so once the bank grew past
    // that, whole categories silently vanished from the pick board.
    let poolQuery = supabase
      .from('questions')
      .select('id, category_id, categories(name)')
      .eq('status', 'active')
      .eq('type', questionType)
      .eq('difficulty', difficulty)
      .order('id')
      .range(0, 4999);
    if (allowedCategoryIds && allowedCategoryIds.length > 0) poolQuery = poolQuery.in('category_id', allowedCategoryIds);
    const { data: pool, error: poolError } = await poolQuery;
    if (poolError) throw poolError;
    const seen = new Set<string>();
    const categories: { category_id: string; category_name: string }[] = [];
    for (const q of (pool || []) as any[]) {
      if (usedQuestionIds.has(q.id)) continue;
      if (seen.has(q.category_id)) continue;
      seen.add(q.category_id);
      categories.push({ category_id: q.category_id, category_name: q.categories?.name || '—' });
    }
    return { difficulty, categories, nextItemId: unpicked[0].id, done: false };
  }
  return { difficulty: null, categories: [], nextItemId: null, done: true };
}

export async function setCurrentPicker(sessionId: string, teamId: string | null) {
  const { error } = await supabase.from('live_sessions').update({ current_picker_team_id: teamId }).eq('id', sessionId);
  if (error) throw error;
}

// ---- Rapid Fire ----
// No question bank involved at all — the host just picks who's up, starts a timer, and taps
// Correct/Wrong live off a physical question sheet. current_picker_team_id (already used for
// team-picks-category rounds) doubles as "whose turn it is" here too.
export async function startRapidFireTurn(sessionId: string, teamId: string) {
  await supabase.from('live_sessions').update({
    current_picker_team_id: teamId, display_state: 'rapid_fire', timer_state: {},
  }).eq('id', sessionId);
}

export async function openCategoryPicks(sessionId: string) {
  await supabase.from('live_sessions').update({ display_state: 'category_pick', timer_state: {} }).eq('id', sessionId);
  await logEvent(sessionId, 'category_picks_opened', {});
}

/** itemId is a free slot at the current tier (from computeCurrentTierAsync's nextItemId);
 * categoryId is the team's free choice. Assigns a random not-yet-used question from that
 * category+tier to the slot and reveals it. */
export async function pickCategory(sessionId: string, itemId: string, teamId: string, categoryId: string) {
  const { data: item } = await supabase.from('question_set_items').select('id, question_set_id, difficulty, picked_by_team_id').eq('id', itemId).single();
  if (!item) throw new Error('Question slot not found.');
  if (item.picked_by_team_id) throw new Error('That slot has already been picked.');

  const { data: qset } = await supabase.from('question_sets').select('round_id').eq('id', item.question_set_id).single();
  const { data: round } = qset ? await supabase.from('rounds').select('timer_seconds, round_type').eq('id', qset.round_id).single() : { data: null };

  const { data: existing } = await supabase
    .from('question_set_items')
    .select('question_id')
    .eq('question_set_id', item.question_set_id)
    .not('question_id', 'is', null);
  const usedIds = (existing || []).map((r: any) => r.question_id);

  // Must match the round's question type, or a Sequencing/Picture pick round gets handed a text
  // MCQ that its UI can't render and its grader can't mark.
  let candidateQuery = supabase.from('questions').select('id')
    .eq('category_id', categoryId).eq('difficulty', item.difficulty).eq('status', 'active')
    .eq('type', questionTypeForRound(round?.round_type || 'MCQ'))
    .order('id').range(0, 4999);
  if (usedIds.length > 0) candidateQuery = candidateQuery.not('id', 'in', `(${usedIds.join(',')})`);
  const { data: candidates } = await candidateQuery;
  if (!candidates || candidates.length === 0) {
    throw new Error('No questions left in that category for this difficulty — ask the team to pick another.');
  }
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];

  const { data: opts } = await supabase.from('question_options').select('option_key').eq('question_id', chosen.id);
  const optionOrder = shuffleArr((opts || []).map((o: any) => o.option_key));

  // Only claim a slot that is still free. Two clients (the host's grid and the picking team's own
  // screen) can both act on the same slot; without this, the second write silently replaced the
  // first team's question after it was already on the display.
  const { data: claimed, error: claimError } = await supabase.from('question_set_items').update({
    category_id: categoryId, question_id: chosen.id, option_order: optionOrder,
    picked_by_team_id: teamId, picked_at: new Date().toISOString(),
  }).eq('id', itemId).is('picked_by_team_id', null).select('id');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) throw new Error('That slot was just picked by someone else.');
  await supabase.from('live_sessions').update({
    current_question_set_item_id: itemId, display_state: 'question',
    timer_state: autoStartTimerState(round?.timer_seconds),
  }).eq('id', sessionId);
  await logEvent(sessionId, 'category_picked', { itemId, teamId, categoryId, questionId: chosen.id });
}

// ---- timer (server-authoritative-ish: we store startedAt + duration, all clients compute remaining) ----
export async function startTimer(sessionId: string, seconds: number) {
  await supabase.from('live_sessions').update({
    timer_state: { duration: seconds, startedAt: new Date().toISOString(), paused: false, remaining: null },
  }).eq('id', sessionId);
}

export async function pauseTimer(sessionId: string, remaining: number) {
  await supabase.from('live_sessions').update({
    timer_state: { paused: true, remaining },
  }).eq('id', sessionId);
}

export async function resetTimer(sessionId: string) {
  await supabase.from('live_sessions').update({ timer_state: {} }).eq('id', sessionId);
}

// ---- display state toggles ----
export async function setDisplayState(sessionId: string, state: string) {
  await supabase.from('live_sessions').update({ display_state: state }).eq('id', sessionId);
}

// ---- buzzer ----
/** Always starts clean: clears any buzzer_events already on this question before opening, so a
 * leftover buzz from earlier testing (or a re-opened buzzer after "Reset Scores", which only
 * clears the scores table, not buzzer state) can never silently lock out real teams. */
export async function openBuzzer(sessionId: string, itemId: string | null) {
  if (itemId) {
    await supabase.from('buzzer_events').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId);
  }
  await setDisplayState(sessionId, 'buzzer_open');
  await logEvent(sessionId, 'buzzer_opened', {});
}

export async function closeBuzzer(sessionId: string) {
  await setDisplayState(sessionId, 'question');
  await logEvent(sessionId, 'buzzer_closed', {});
}

/** Clears the buzzes on this question AND any points already awarded from judging them, so the
 * buzzer can genuinely be re-run. (Without the score delete, resetting after a wrong judgement
 * left the penalty in place with no buzz record to explain it.) */
export async function resetBuzzer(sessionId: string, itemId: string) {
  const [buzzes, scores] = await Promise.all([
    supabase.from('buzzer_events').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId),
    supabase.from('scores').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId).eq('source', 'auto_buzzer'),
  ]);
  if (buzzes.error || scores.error) throw buzzes.error || scores.error;
  await logEvent(sessionId, 'buzzer_reset', { itemId });
}

/** One buzz per team per question.
 *
 * Buzz ORDER is taken from the server-assigned `buzzed_at` clock, never computed here. The old
 * version read a count and inserted `position = count + 1`, which is a read-then-write race: two
 * teams slapping the buzzer within the same network round-trip both read 0 and both wrote
 * position 1. Postgres then returned those tied rows in arbitrary order, so the Team and Display
 * screens (which ranked by `position`) could name a different team as "first" than the Host
 * screen (which ranked by `buzzed_at`) — on exactly the contested buzz where it matters most.
 * Every screen now orders by `buzzed_at`, so they cannot disagree.
 *
 * A duplicate buzz from the same team hits the unique (session, item, team) constraint; that's
 * the expected outcome of a double-tap, not an error worth showing anyone. */
export async function submitBuzz(sessionId: string, itemId: string, teamId: string) {
  const { data, error } = await supabase.from('buzzer_events').insert({
    session_id: sessionId, question_set_item_id: itemId, team_id: teamId, status: 'pending',
  }).select().single();
  if (error && (error as { code?: string }).code === '23505') return { data: null, error: null };
  return { data, error };
}

/** Step 1 of judging a buzz: the host decides whether this team gets to answer out loud at all.
 * 'accepted' just opens the floor to them — no score yet, since they haven't said an answer.
 * 'rejected' disqualifies this buzz outright (e.g. a false start / buzzed before the question
 * finished) with no score either, and — because it doesn't hold the floor — the next team in
 * buzz order becomes eligible to answer instead (see the `activeBuzz` logic on Team/Host/Display,
 * which skips rejected rows when deciding who currently holds the floor). */
export async function decideBuzz(
  sessionId: string, buzzerEventId: string, teamId: string, roundId: string | null,
  decision: 'accepted' | 'rejected'
) {
  const { error } = await supabase.from('buzzer_events').update({ status: decision }).eq('id', buzzerEventId);
  if (error) throw error;
}

/** Step 2: after an accepted team has actually spoken their answer, the host judges it correct
 * or wrong — this is the point real points get awarded, same shape as MCQ grading.
 *
 * Scoring is gated on the status transition `accepted -> correct/wrong`, so it can only ever
 * happen ONCE per buzz. Previously a second click scored again: double-tapping "✓ Correct" gave
 * +10 twice, and — worse — clicking "✓ Correct" then "✗ Wrong" to correct a misjudgement awarded
 * BOTH, leaving a team +5 up on a wrong answer instead of −5 down. To re-judge a buzz now, the
 * host resets the buzzer, which also removes the score it wrote. */
export async function judgeBuzzAnswer(
  sessionId: string, buzzerEventId: string, teamId: string, roundId: string | null,
  correct: boolean, marksCorrect: number, marksWrong: number, itemId?: string | null
) {
  const status = correct ? 'correct' : 'wrong';
  const penaltyMarks = correct ? 0 : Math.abs(marksWrong);
  const { data: updated, error: updateError } = await supabase.from('buzzer_events')
    .update({ status, penalty_marks: penaltyMarks })
    .eq('id', buzzerEventId).eq('status', 'accepted')
    .select('id');
  if (updateError) throw updateError;
  if (!updated || updated.length === 0) return; // already judged — never score the same buzz twice

  const points = correct ? marksCorrect : -Math.abs(marksWrong);
  if (points !== 0) {
    const { error } = await supabase.from('scores').insert({
      session_id: sessionId, team_id: teamId, round_id: roundId, question_set_item_id: itemId ?? null, points,
      reason: correct ? 'Buzzer correct' : 'Buzzer wrong', source: 'auto_buzzer',
    });
    if (error) throw error;
  }
}

// ---- MCQ answers ----
// Upsert (not plain insert) because the host can re-lock a different option for the same
// team/question before Reveal — e.g. correcting a misclick — and there's a unique constraint
// on (session_id, question_set_item_id, team_id) that a second insert would violate.
export async function submitAnswer(sessionId: string, itemId: string, teamId: string, selectedKey: string) {
  return supabase.from('answers').upsert({
    session_id: sessionId, question_set_item_id: itemId, team_id: teamId,
    answer_json: { selected: selectedKey },
  }, { onConflict: 'session_id,question_set_item_id,team_id' });
}

// ---- Sequencing answers ----
// Same answers table/upsert shape as MCQ, just a full ordered list of option_keys instead of
// one selected key — grading compares the whole array against the options' correct sort_order.
export async function submitSequenceAnswer(sessionId: string, itemId: string, teamId: string, orderedKeys: string[]) {
  return supabase.from('answers').upsert({
    session_id: sessionId, question_set_item_id: itemId, team_id: teamId,
    answer_json: { order: orderedKeys },
  }, { onConflict: 'session_id,question_set_item_id,team_id' });
}

export type SequenceResult = {
  team_id: string; team_name: string; order: string[];
  is_correct: boolean | null; awarded_marks: number | null; submitted_at: string;
};

/** Every team's submitted order for a Sequencing question, oldest submission first — the same
 * `submitted_at` server clock the Host/Team/Display screens already use for the buzzer, so a
 * completion time computed from it lines up across every screen. Called once the question is
 * revealed, so the Host and Display screens can show who nailed the order and how fast. */
export async function fetchSequenceResults(sessionId: string, itemId: string): Promise<SequenceResult[]> {
  const { data } = await supabase.from('answers')
    .select('team_id, answer_json, is_correct, awarded_marks, submitted_at, teams(name)')
    .eq('session_id', sessionId).eq('question_set_item_id', itemId)
    .order('submitted_at');
  return (data || []).map((a: any) => ({
    team_id: a.team_id, team_name: a.teams?.name || 'Unknown team',
    order: a.answer_json?.order || [], is_correct: a.is_correct, awarded_marks: a.awarded_marks,
    submitted_at: a.submitted_at,
  }));
}

// ---- passing (MCQ rounds only — not Buzzer, not Rapid Fire, not Sequencing, which is answered
// simultaneously by every team rather than one team at a time) ----
// A fixed, deliberately-smaller reward for whoever ends up answering a question other teams
// already declined — see gradeAndReveal, which checks whether any pass exists on the item.
export const PASS_MARKS_CORRECT = 5;

/** Records that a team declined to answer — no score, no penalty. Duplicate presses for the same
 * team on the same question hit the unique constraint; treated as a no-op, same pattern as a
 * duplicate buzz, not an error worth surfacing. */
export async function passQuestion(sessionId: string, itemId: string, teamId: string) {
  const { error } = await supabase.from('question_passes').insert({
    session_id: sessionId, question_set_item_id: itemId, team_id: teamId,
  });
  if (error && (error as { code?: string }).code === '23505') return { error: null };
  return { error };
}

export type PassedTeam = { team_id: string; team_name: string };

/** Every team that's passed on this question so far, in the order they passed — lets the Host
 * screen show who's already out of the running and pick a fresh team to hand it to. */
export async function fetchPassedTeams(sessionId: string, itemId: string): Promise<PassedTeam[]> {
  const { data } = await supabase.from('question_passes')
    .select('team_id, teams(name)').eq('session_id', sessionId).eq('question_set_item_id', itemId)
    .order('passed_at');
  return (data || []).map((p: any) => ({ team_id: p.team_id, team_name: p.teams?.name || 'Unknown team' }));
}

/** Grades all submitted answers for the current question — MCQ against the (host-only) correct
 * answer key, Sequencing against the options' correct sort_order — writes awarded_marks back
 * onto each answers row, records score transactions, and moves the session into answer_reveal. */
export async function gradeAndReveal(sessionId: string, itemId: string, roundId: string) {
  const { data: item } = await supabase.from('question_set_items').select('question_id').eq('id', itemId).single();
  if (!item) return;

  // Idempotency guard. This function inserts a score row per team, so running it twice on the
  // same question doubled every team's points for it — and the Reveal button stayed clickable
  // after the reveal was already on screen, so one extra click (or an impatient double-click)
  // was all it took. Re-revealing an already-graded question is now just a display change.
  const { count: alreadyScored } = await supabase.from('scores')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('question_set_item_id', itemId)
    .in('source', ['auto_mcq', 'auto_sequence']);
  if ((alreadyScored || 0) > 0) {
    await setDisplayState(sessionId, 'answer_reveal');
    return;
  }
  const { data: question } = await supabase.from('questions').select('type, answer').eq('id', item.question_id).single();
  const { data: round } = await supabase.from('rounds').select('marks_correct, marks_wrong').eq('id', roundId).single();
  const { data: answerRows } = await supabase.from('answers').select('*').eq('session_id', sessionId).eq('question_set_item_id', itemId);

  // PASS_MARKS_CORRECT: once any team has passed on this question, whoever finally answers it
  // correctly gets this fixed award instead of the round's normal marks_correct — a deliberately
  // smaller, flat bonus since they got a question other teams already had a crack at, not their
  // own fresh pick. A wrong answer after a pass still costs the round's normal marks_wrong;
  // passing itself never costs anything (no row is written for the team that declines to answer).
  const { count: passCount } = await supabase.from('question_passes')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('question_set_item_id', itemId);
  const effectiveMarksCorrect = (passCount || 0) > 0 ? PASS_MARKS_CORRECT : (round?.marks_correct ?? 0);

  let correctOrder: string[] | null = null;
  if (question?.type === 'SEQUENCE') {
    const { data: opts } = await supabase.from('question_options').select('option_key, sort_order').eq('question_id', item.question_id).order('sort_order');
    correctOrder = (opts || []).map((o: any) => o.option_key);
  }

  for (const a of answerRows || []) {
    let isCorrect: boolean;
    if (question?.type === 'SEQUENCE') {
      const submitted: string[] = a.answer_json?.order || [];
      isCorrect = !!correctOrder && correctOrder.length > 0 &&
        submitted.length === correctOrder.length && submitted.every((k, i) => k === correctOrder![i]);
    } else {
      const selected = a.answer_json?.selected;
      isCorrect = !!question && selected === question.answer;
    }
    // marks_wrong is a penalty MAGNITUDE (how many points to dock), whichever sign it was
    // saved with — always subtract its absolute value so a round saved as either 5 or -5
    // behaves the same way, rather than a stray "-5" flipping into a +5 bonus.
    const awarded = isCorrect ? effectiveMarksCorrect : -Math.abs(round?.marks_wrong ?? 0);
    await supabase.from('answers').update({ is_correct: isCorrect, awarded_marks: awarded, locked_at: new Date().toISOString() }).eq('id', a.id);
    if (awarded !== 0) {
      // question_set_item_id ties the score to the question that produced it, so "Reset Question"
      // can take its points back and the idempotency check above can see it.
      await supabase.from('scores').insert({
        session_id: sessionId, team_id: a.team_id, round_id: roundId, question_set_item_id: itemId, points: awarded,
        reason: isCorrect ? 'Correct answer' : 'Wrong answer', source: question?.type === 'SEQUENCE' ? 'auto_sequence' : 'auto_mcq',
      });
    }
  }
  await setDisplayState(sessionId, 'answer_reveal');
  await logEvent(sessionId, 'answer_revealed', { itemId });
}

// ---- manual scoring ----
// Throws on failure. Supabase never throws by itself — it returns { error } — so a write that
// was rejected (RLS, dropped connection) used to look exactly like a successful one: the host
// clicked, the counter went up, and no points were ever recorded.
export async function awardManualScore(sessionId: string, teamId: string, roundId: string | null, points: number, reason: string) {
  const { error } = await supabase.from('scores').insert({ session_id: sessionId, team_id: teamId, round_id: roundId, points, reason, source: 'manual' });
  if (error) throw error;
  await logEvent(sessionId, 'manual_score', { teamId, points, reason });
}

/** Reverses a score transaction by inserting an equal-and-opposite entry (keeps audit history). */
export async function undoScore(score: { id: string; session_id: string; team_id: string; round_id: string | null; points: number; reason: string | null }) {
  const { error } = await supabase.from('scores').insert({
    session_id: score.session_id, team_id: score.team_id, round_id: score.round_id,
    points: -score.points, reason: `Undo: ${score.reason || 'previous action'}`, source: 'undo',
  });
  if (error) throw error;
}

// ---- elimination ----
/** No-ops if the team is already eliminated, so a double-click can't leave two open elimination
 * rows (which would then need two restores to undo). */
export async function eliminateTeam(sessionId: string, teamId: string, roundId: string | null, reason: string) {
  const { count } = await supabase.from('eliminations').select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('team_id', teamId).is('reversed_at', null);
  if ((count || 0) > 0) return;
  const { error } = await supabase.from('eliminations').insert({ session_id: sessionId, team_id: teamId, round_id: roundId, reason });
  if (error) throw error;
  await supabase.from('teams').update({ eliminated_at: new Date().toISOString() }).eq('id', teamId);
  await logEvent(sessionId, 'team_eliminated', { teamId, reason });
}

/** Reverses EVERY open elimination for the team, not just the one row that was clicked —
 * otherwise a team could be back in play while still listed as eliminated on the results page. */
export async function restoreTeam(eliminationId: string, teamId: string) {
  const { error } = await supabase.from('eliminations').update({ reversed_at: new Date().toISOString() })
    .eq('team_id', teamId).is('reversed_at', null);
  if (error) throw error;
  await supabase.from('teams').update({ eliminated_at: null }).eq('id', teamId);
}

// ---- reset ----
/** Clears the question so it can be re-run: answers, buzzes, AND the points those produced.
 * The points used to be left behind, so re-running a question stacked a second award on top of
 * the first while deleting the answer rows that explained where the first one came from. Manual
 * host adjustments are deliberately kept — only auto-awarded points are taken back. */
export async function resetCurrentQuestion(sessionId: string, itemId: string) {
  const [answers, buzzes, scores, passes] = await Promise.all([
    supabase.from('answers').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId),
    supabase.from('buzzer_events').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId),
    supabase.from('scores').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId)
      .in('source', ['auto_mcq', 'auto_sequence', 'auto_buzzer']),
    supabase.from('question_passes').delete().eq('session_id', sessionId).eq('question_set_item_id', itemId),
  ]);
  const err = answers.error || buzzes.error || scores.error || passes.error;
  if (err) throw err;
  // Re-arm the clock too, same as showing a fresh question — otherwise a re-run question kept
  // whatever stale/expired timer_state it had before the reset (often already at 0), so the
  // "completed in Ns" figure on a re-answered Sequencing question came out wrong or missing.
  const { data: item } = await supabase.from('question_set_items').select('question_set_id').eq('id', itemId).single();
  const { data: set } = item ? await supabase.from('question_sets').select('round_id').eq('id', item.question_set_id).maybeSingle() : { data: null };
  const { data: round } = set?.round_id ? await supabase.from('rounds').select('timer_seconds').eq('id', set.round_id).maybeSingle() : { data: null };
  await supabase.from('live_sessions').update({
    display_state: 'question', timer_state: autoStartTimerState(round?.timer_seconds),
  }).eq('id', sessionId);
  await logEvent(sessionId, 'question_reset', { itemId });
}

export async function resetRound(sessionId: string, roundId: string) {
  const { data: round } = await supabase.from('rounds').select('team_picks_category').eq('id', roundId).maybeSingle();
  const items = await getOrderedItems(sessionId, roundId);
  const itemIds = items.map(i => i.id);
  if (itemIds.length > 0) {
    await Promise.all([
      supabase.from('answers').delete().eq('session_id', sessionId).in('question_set_item_id', itemIds),
      supabase.from('buzzer_events').delete().eq('session_id', sessionId).in('question_set_item_id', itemIds),
      supabase.from('question_passes').delete().eq('session_id', sessionId).in('question_set_item_id', itemIds),
    ]);
  }
  await supabase.from('scores').delete().eq('session_id', sessionId).eq('round_id', roundId);
  if (itemIds.length > 0) {
    // For team-picks-category rounds, reset the slots all the way back to blank (no
    // category/question assigned) so teams pick fresh categories again, not the same ones.
    const resetFields: Record<string, unknown> = { picked_by_team_id: null, picked_at: null };
    if (round?.team_picks_category) { resetFields.category_id = null; resetFields.question_id = null; resetFields.option_order = []; }
    await supabase.from('question_set_items').update(resetFields).in('id', itemIds);
  }
  await supabase.from('live_sessions').update({
    current_question_set_item_id: null, current_picker_team_id: null, display_state: 'round_intro', timer_state: {},
  }).eq('id', sessionId);
  await logEvent(sessionId, 'round_reset', { roundId });
}

export async function resetScores(sessionId: string) {
  // Deletes every score row for the session outright, rather than inserting negation entries —
  // negating-in-place used to re-read (and re-negate) its own reset rows on every subsequent
  // click, snowballing the table (and, past Supabase's 1000-row default page size, silently only
  // ever seeing/negating a partial slice — meaning totals could never actually reach zero once a
  // session accumulated enough rows). A hard delete is simple, instant, and idempotent.
  const { error } = await supabase.from('scores').delete().eq('session_id', sessionId);
  if (error) throw error;
  await logEvent(sessionId, 'scores_reset', {});
}

/** Full rewind — used to replay a session (e.g. running the real show on a session that was
 * rehearsed on). Also clears answers, buzzes and every slot's pick state: leaving them behind
 * meant a rehearsal's answers were still sitting in the table, so the first Reveal of the real
 * show graded and awarded points for answers submitted the day before. Scores are left alone —
 * "Reset Scores" is its own button — so run both for a true clean slate. */
export async function resetSession(sessionId: string) {
  const [answers, buzzes] = await Promise.all([
    supabase.from('answers').delete().eq('session_id', sessionId),
    supabase.from('buzzer_events').delete().eq('session_id', sessionId),
  ]);
  if (answers.error || buzzes.error) throw answers.error || buzzes.error;

  const { data: sets } = await supabase.from('question_sets').select('id').eq('session_id', sessionId);
  const setIds = (sets || []).map(s => s.id);
  if (setIds.length > 0) {
    await supabase.from('question_set_items')
      .update({ picked_by_team_id: null, picked_at: null })
      .in('question_set_id', setIds);
  }

  const { error } = await supabase.from('live_sessions').update({
    status: 'not_started', current_round_id: null, current_question_set_item_id: null,
    current_picker_team_id: null, display_state: 'idle', timer_state: {}, started_at: null,
  }).eq('id', sessionId);
  if (error) throw error;
  await logEvent(sessionId, 'session_reset', {});
}

// ---- winner ----
export type TeamMember = { name: string; photo_url: string };
export type WinnerInfo = { team_id: string; team_name: string; logo_url: string | null; members: TeamMember[] };

/** Declares a team the session's winner and moves the display straight to the Winners screen —
 * one action for the host, rather than a separate "pick winner" step and a separate "show
 * winners" step that could be done out of order (or forgotten). */
export async function declareWinner(sessionId: string, teamId: string) {
  const { error } = await supabase.from('live_sessions').update({
    winner_team_id: teamId, display_state: 'winners',
  }).eq('id', sessionId);
  if (error) throw error;
  await logEvent(sessionId, 'winner_declared', { teamId });
}

/** Undoes a Declare Winner — clears the winner and drops the display back to the scoreboard, so a
 * host who confirmed the wrong team (or is just re-running a trial) isn't stuck on the Winners
 * screen with no way back. */
export async function resetWinner(sessionId: string) {
  const { error } = await supabase.from('live_sessions').update({
    winner_team_id: null, display_state: 'scoreboard',
  }).eq('id', sessionId);
  if (error) throw error;
  await logEvent(sessionId, 'winner_reset', {});
}

/** The declared winner's name, logo and members — null if no winner has been declared yet (e.g.
 * a team/display screen loading before the host has clicked Declare Winner). */
export async function fetchWinner(winnerTeamId: string | null | undefined): Promise<WinnerInfo | null> {
  if (!winnerTeamId) return null;
  const { data } = await supabase.from('teams').select('id, name, logo_url, members').eq('id', winnerTeamId).maybeSingle();
  if (!data) return null;
  return { team_id: data.id, team_name: data.name, logo_url: data.logo_url, members: (data.members as TeamMember[]) || [] };
}
