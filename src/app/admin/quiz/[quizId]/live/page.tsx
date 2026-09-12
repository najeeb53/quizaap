'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import {
  fetchActiveQuestionPool, computeAvailability, generateQuestionSetItems, generateTierSlots, attachShuffledOptionOrder,
  saveQuestionSet, lockQuestionSet, DIFFICULTY_ORDER, questionTypeForRound,
  type PoolQuestion, type GeneratedItem,
} from '@/lib/questionSet';

type Round = { id: string; sequence_no: number; name: string; round_type: string; question_count: number; team_picks_category: boolean; category_ids: string[] | null };
type Category = { id: string; name: string };
type LiveSession = { id: string; status: string; started_at: string | null; ended_at: string | null };
type QuestionSet = { id: string; round_id: string; locked_at: string | null; item_count: number };

// counts[categoryId][difficulty] = how many to pull
type CountsMatrix = Record<string, Record<string, number>>;

export default function LivePage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [pool, setPool] = useState<PoolQuestion[]>([]);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [sets, setSets] = useState<Record<string, QuestionSet>>({});
  const [loading, setLoading] = useState(true);

  const [genRoundId, setGenRoundId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountsMatrix>({});
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<{ text: string; category: string; difficulty: string }[] | null>(null);
  const [previewItems, setPreviewItems] = useState<Omit<GeneratedItem, 'option_order'>[] | null>(null);
  const [previewSlots, setPreviewSlots] = useState<{ difficulty: string; display_order: number }[] | null>(null);
  const [genErrors, setGenErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const genModalRef = useRef<HTMLDialogElement>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: rs }, { data: cats }, activePool, { data: sess }] = await Promise.all([
      supabase.from('rounds').select('id, sequence_no, name, round_type, question_count, team_picks_category, category_ids').eq('quiz_id', quizId).order('sequence_no'),
      supabase.from('categories').select('id, name').order('name'),
      fetchActiveQuestionPool('MCQ'), // default pool for the list view's "questions needed" hints; Generate modal re-fetches scoped to the round's actual type
      supabase.from('live_sessions').select('id, status, started_at, ended_at').eq('quiz_id', quizId).neq('status', 'ended').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    setRounds(rs || []);
    setCategories(cats || []);
    setPool(activePool);
    setSession(sess || null);

    if (sess) {
      const { data: qsets } = await supabase.from('question_sets').select('id, round_id, locked_at, question_set_items(id)').eq('session_id', sess.id);
      const map: Record<string, QuestionSet> = {};
      for (const s of qsets || []) {
        map[s.round_id] = { id: s.id, round_id: s.round_id, locked_at: s.locked_at, item_count: (s as any).question_set_items?.length || 0 };
      }
      setSets(map);
    } else {
      setSets({});
    }
    setLoading(false);
  }, [quizId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function startSession() {
    const { data, error } = await supabase.from('live_sessions').insert({
      quiz_id: quizId, status: 'not_started', display_state: 'idle',
    }).select().single();
    if (error) { console.error(error); return; }
    // A new show starts with every team in it. Eliminations are recorded per session, but the
    // team's own eliminated_at flag is not — so without this, teams knocked out of the previous
    // session stay knocked out here: absent from the scoring console and the picking rotation,
    // and locked out of their own consoles, with nothing on screen explaining why.
    await supabase.from('teams').update({ eliminated_at: null })
      .eq('quiz_id', quizId).not('eliminated_at', 'is', null);
    setSession(data);
    fetchAll();
  }

  async function endSession() {
    if (!session) return;
    await supabase.from('live_sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', session.id);
    fetchAll();
  }

  async function handleUnlock(round: Round) {
    if (!session) return;
    const confirmed = window.confirm(
      `Unlock "${round.name}"? This deletes its current question set and any scores/answers already recorded for this round in this session, so you can regenerate it with different settings. Only do this if the round hasn't been played yet (or you want to redo it).`
    );
    if (!confirmed) return;
    // Clear the session's pointer unconditionally — it can still reference an item of THIS round
    // even after the host has moved to a later one, and while it does, the foreign key blocks the
    // question-set delete below.
    await supabase.from('live_sessions')
      .update({ current_question_set_item_id: null, current_picker_team_id: null })
      .eq('id', session.id);

    // Delete the set BEFORE the scores. The old order deleted the scores first and ignored the
    // set-delete error, so a blocked unlock destroyed the round's scores and left it locked.
    const { error: setErr } = await supabase.from('question_sets').delete().eq('session_id', session.id).eq('round_id', round.id); // cascades to items → answers/buzzer_events
    if (setErr) { alert(`Unlock failed: ${setErr.message}`); return; }
    const { error: scoreErr } = await supabase.from('scores').delete().eq('session_id', session.id).eq('round_id', round.id);
    if (scoreErr) alert(`The question set was unlocked, but this round's scores could not be cleared: ${scoreErr.message}`);
    fetchAll();
  }

  const availability = computeAvailability(pool);
  const genRound = rounds.find(r => r.id === genRoundId);
  const roundCategoryIds = genRound?.category_ids && genRound.category_ids.length > 0 ? new Set(genRound.category_ids) : null;
  // categories that have at least one active question, in any difficulty, and are in play for
  // this round (the admin's per-round category assignment — all categories if none is set)
  const categoriesWithQuestions = categories.filter(c =>
    availability[c.id] && Object.values(availability[c.id]).some(n => n > 0) && (!roundCategoryIds || roundCategoryIds.has(c.id))
  );
  // union of difficulty labels actually present in the data, ordered Easy/Medium/Hard first
  const difficultiesPresent = (() => {
    const set = new Set<string>();
    for (const cell of Object.values(availability)) for (const d of Object.keys(cell)) set.add(d);
    const extra = [...set].filter(d => !DIFFICULTY_ORDER.includes(d)).sort();
    return [...DIFFICULTY_ORDER.filter(d => set.has(d)), ...extra];
  })();

  async function openGenerate(round: Round) {
    setGenRoundId(round.id);
    setPreview(null);
    setPreviewItems(null);
    setPreviewSlots(null);
    setGenErrors([]);
    setCounts({});
    setTierCounts({});
    // Picture rounds pull from PICTURE questions, everything else from MCQ — re-fetch the pool
    // scoped to this round's type so availability counts and generation never mix the two.
    setPool(await fetchActiveQuestionPool(questionTypeForRound(round.round_type)));
    genModalRef.current?.showModal();
  }

  // Any change to the counts invalidates the preview. Without this, editing a cell after
  // previewing left the Lock button active and locking the OLD preview — while the list on
  // screen still matched it, so nothing looked wrong.
  function clearPreview() {
    setPreview(null);
    setPreviewItems(null);
    setPreviewSlots(null);
    setGenErrors([]);
  }

  function setTierCount(difficulty: string, value: number) {
    clearPreview();
    setTierCounts(prev => ({ ...prev, [difficulty]: Math.max(0, value || 0) }));
  }

  function setCount(categoryId: string, difficulty: string, value: number) {
    clearPreview();
    const max = availability[categoryId]?.[difficulty] || 0;
    const clamped = Math.max(0, Math.min(max, value || 0));
    setCounts(prev => ({ ...prev, [categoryId]: { ...(prev[categoryId] || {}), [difficulty]: clamped } }));
  }

  const totalCount = Object.values(counts).reduce((sum, byDiff) => sum + Object.values(byDiff).reduce((a, b) => a + b, 0), 0);
  const tierTotalCount = Object.values(tierCounts).reduce((a, b) => a + b, 0);
  const isPickRound = !!genRound?.team_picks_category;
  const questionsNeeded = genRound?.question_count ?? 0;
  const selectedTotal = isPickRound ? tierTotalCount : totalCount;
  // The count has to MATCH, not merely be non-zero. Previewing and locking used to be allowed at
  // any total, so a round set up for 10 could be locked holding 1 — and on the night it simply
  // ended after the first question with no warning.
  const countOk = questionsNeeded > 0 && selectedTotal === questionsNeeded;

  async function handlePreview() {
    setBusy(true);
    setGenErrors([]);

    if (isPickRound) {
      // Blank slots are filled live from the bank, so more slots than the bank can supply means
      // the round dead-ends mid-show on "no questions left in that category".
      const availByDiff: Record<string, number> = {};
      for (const c of categoriesWithQuestions) {
        for (const [d, n] of Object.entries(availability[c.id] || {})) availByDiff[d] = (availByDiff[d] || 0) + n;
      }
      const shortfalls = Object.entries(tierCounts)
        .filter(([d, n]) => n > 0 && n > (availByDiff[d] || 0))
        .map(([d, n]) => `Not enough ${d} questions for this round's categories: ${n} slots requested, only ${availByDiff[d] || 0} available.`);
      if (shortfalls.length > 0) { setBusy(false); setGenErrors(shortfalls); setPreview(null); setPreviewSlots(null); return; }

      const slots = generateTierSlots(tierCounts);
      setBusy(false);
      setPreviewSlots(slots);
      setPreview(slots.map(s => ({ text: '(picked live by the team)', category: '— any available —', difficulty: s.difficulty })));
      setPreviewItems(null);
      return;
    }

    // Exclude questions already drawn into another round of this session, so the same question
    // can't come up twice in one show.
    let usedIds: string[] = [];
    if (session) {
      const { data: used } = await supabase.from('question_set_items')
        .select('question_id, question_sets!inner(session_id)')
        .eq('question_sets.session_id', session.id)
        .not('question_id', 'is', null);
      usedIds = (used || []).map((r: any) => r.question_id);
    }

    const { items, errors } = generateQuestionSetItems(pool, counts, usedIds);
    if (errors.length > 0) { setBusy(false); setGenErrors(errors); setPreview(null); setPreviewItems(null); return; }
    const { data: qs } = await supabase.from('questions').select('id, text, category_id, difficulty').in('id', items.map(i => i.question_id));
    const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
    const rows = items.map(item => {
      const q = qs?.find(q => q.id === item.question_id);
      return { text: q?.text || '(unknown)', category: catMap[item.category_id!] || '—', difficulty: q?.difficulty || '' };
    });
    setBusy(false);
    setPreview(rows);
    setPreviewItems(items);
  }

  async function handleLock() {
    if (!session || !genRoundId) return;
    setBusy(true);
    try {
      let setId: string;
      if (isPickRound) {
        if (!previewSlots) throw new Error('Nothing to lock.');
        const blank: GeneratedItem[] = previewSlots.map(s => ({
          question_id: null, category_id: null, option_order: [], difficulty: s.difficulty, display_order: s.display_order,
        }));
        setId = await saveQuestionSet(session.id, genRoundId, blank);
      } else {
        if (!previewItems) throw new Error('Nothing to lock.');
        const withOptions = await attachShuffledOptionOrder(previewItems);
        setId = await saveQuestionSet(session.id, genRoundId, withOptions);
      }
      await lockQuestionSet(setId);
      genModalRef.current?.close();
      fetchAll();
    } catch (e: any) {
      setGenErrors([e.message || 'Failed to lock question set.']);
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">🎯 Live Session Setup</h1>
        <p className="text-gray-600 mt-1">Start the live session, share the host and display links, and lock in each round's question set.</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg p-8 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-xl font-semibold text-gray-900">Live Session</h3>
          {loading ? (
            <p className="text-sm text-gray-500 mt-1">Loading…</p>
          ) : session ? (
            <p className="text-sm text-gray-600 mt-1">
              Status:{' '}
              <span className={`inline-block ml-1 rounded-full px-3 py-1 text-xs font-semibold ${
                session.status === 'ended' ? 'bg-red-100 text-red-700'
                  : session.status === 'not_started' ? 'bg-amber-100 text-amber-700'
                  : 'bg-green-100 text-green-700'
              }`}>{session.status}</span>
            </p>
          ) : (
            <p className="text-sm text-gray-500 mt-1">No active session for this quiz yet.</p>
          )}
        </div>
        <div className="flex gap-3 flex-wrap">
          {!session && (
            <button onClick={startSession}
              className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-6 py-3 rounded-xl text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
              Start Live Session
            </button>
          )}
          {session && (
            <>
              <Link href={`/host/${session.id}`} target="_blank" rel="noopener noreferrer"
                className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-6 py-3 rounded-xl text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
                Open Host Console ↗
              </Link>
              <Link href={`/display/${session.id}`} target="_blank" rel="noopener noreferrer"
                className="bg-gradient-to-r from-gray-800 to-gray-900 hover:from-gray-900 hover:to-black text-white px-6 py-3 rounded-xl text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
                Open Display ↗
              </Link>
              <button onClick={endSession}
                className="border-2 border-red-300 text-red-600 hover:bg-red-50 px-6 py-3 rounded-xl text-sm font-semibold transition-all duration-200">
                End Session
              </button>
            </>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg overflow-hidden">
        <div className="px-8 py-6 border-b border-gray-200">
          <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">📚 Question Sets per Round</h3>
          <p className="text-sm text-gray-600 mt-1">Choose how many questions of each category and difficulty each round pulls, then lock the set.</p>
        </div>
        {!session ? (
          <p className="p-8 text-gray-500">Start a live session first.</p>
        ) : rounds.length === 0 ? (
          <p className="p-8 text-gray-500">No rounds configured yet. Add rounds first.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rounds.map(r => {
              const set = sets[r.id];
              return (
                <li key={r.id} className="px-8 py-5 flex items-center justify-between flex-wrap gap-3 hover:bg-blue-50/50 transition-colors">
                  <div>
                    <p className="font-semibold text-gray-900">R{r.sequence_no}. {r.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{r.question_count} questions needed</p>
                  </div>
                  {r.round_type === 'RAPID_FIRE' ? (
                    <span className="text-gray-400 text-xs italic">No question set needed — scored live from the host console</span>
                  ) : set?.locked_at ? (
                    <div className="flex items-center gap-3">
                      <span className="text-green-700 bg-green-100 px-3 py-1 rounded-full text-xs font-semibold">🔒 Locked · {set.item_count} questions</span>
                      <button onClick={() => handleUnlock(r)} className="text-xs text-red-600 hover:text-red-700 font-semibold hover:underline">Unlock &amp; Regenerate</button>
                    </div>
                  ) : (
                    <button onClick={() => openGenerate(r)}
                      className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
                      Generate Question Set
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <dialog ref={genModalRef} className="w-full max-w-3xl rounded-2xl shadow-xl backdrop:bg-black/40 border border-gray-200">
        <div className="p-8 flex flex-col gap-5 max-h-[85vh] overflow-y-auto">
          <h3 className="text-xl font-semibold text-gray-900">Generate Question Set — {genRound?.name}</h3>

          {isPickRound ? (
            <>
              <p className="text-sm text-gray-600">
                Teams pick their own category for this round. You only set how many questions are needed at each
                difficulty — the round plays all Easy slots first, then Medium, then Hard. Whichever category still has
                questions left at that difficulty is fair game for the team whose turn it is.
              </p>
              <div className="border-2 border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                {DIFFICULTY_ORDER.map(d => (
                  <div key={d} className="flex items-center justify-between px-4 py-3 bg-white">
                    <span className="font-semibold text-gray-900">{d}</span>
                    <input type="number" min={0} className="border-2 border-gray-200 rounded-lg w-20 p-2 text-center focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      value={tierCounts[d] ?? 0}
                      onChange={e => setTierCount(d, Number(e.target.value))} />
                  </div>
                ))}
              </div>
              <p className={`text-sm font-medium ${tierTotalCount === genRound?.question_count ? 'text-gray-500' : 'text-amber-600'}`}>
                Total slots: {tierTotalCount} / {genRound?.question_count} needed
              </p>
            </>
          ) : categoriesWithQuestions.length === 0 ? (
            <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3">No categories have active questions yet. Add some in the Question Bank first.</p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Needs {genRound?.question_count} questions. Fill in how many should come from each category, per difficulty —
                the round will play easier questions first, then medium, then hard, in that order.
              </p>
              <div className="overflow-x-auto border-2 border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gradient-to-r from-gray-900 to-gray-800 text-white">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Category</th>
                      {difficultiesPresent.map(d => <th key={d} className="text-center px-4 py-3 font-semibold">{d}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {categoriesWithQuestions.map((c, idx) => (
                      <tr key={c.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-4 py-3 font-semibold text-gray-900">{c.name}</td>
                        {difficultiesPresent.map(d => {
                          const avail = availability[c.id]?.[d] || 0;
                          return (
                            <td key={d} className="px-4 py-3 text-center">
                              {avail === 0 ? (
                                <span className="text-gray-300">—</span>
                              ) : (
                                <div className="flex flex-col items-center gap-1">
                                  <input type="number" min={0} max={avail} className="border-2 border-gray-200 rounded-lg w-16 p-1.5 text-center focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                                    value={counts[c.id]?.[d] ?? 0}
                                    onChange={e => setCount(c.id, d, Number(e.target.value))} />
                                  <span className="text-[11px] text-gray-400">{avail} available</span>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={`text-sm font-medium ${countOk ? 'text-gray-500' : 'text-amber-600'}`}>
                Total selected: {totalCount} / {questionsNeeded}
              </p>
            </>
          )}

          {genErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-4">
              {genErrors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={handlePreview} disabled={busy || !countOk}
              className="bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-800 hover:to-gray-900 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
              {busy ? 'Working…' : 'Shuffle / Preview'}
            </button>
            {!countOk && questionsNeeded > 0 && (
              <span className="text-sm text-amber-600">
                Select exactly {questionsNeeded} question{questionsNeeded === 1 ? '' : 's'} to continue — currently {selectedTotal}.
              </span>
            )}
          </div>

          {preview && (
            <div className="border-2 border-gray-200 rounded-lg max-h-64 overflow-y-auto">
              <ol className="divide-y divide-gray-100 text-sm">
                {preview.map((row, i) => (
                  <li key={i} className="px-4 py-2.5 flex justify-between gap-2">
                    <span className="truncate text-gray-900">{i + 1}. {row.text}</span>
                    <span className="text-gray-400 shrink-0">{row.category} · {row.difficulty}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" className="px-5 py-2.5 rounded-lg border-2 border-gray-200 text-gray-700 font-semibold hover:bg-gray-50 transition-all duration-200" onClick={() => genModalRef.current?.close()}>Cancel</button>
            {preview && (
              <button onClick={handleLock} disabled={busy || !countOk}
                className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-200">
                {busy ? 'Locking…' : '🔒 Lock this set'}
              </button>
            )}
          </div>
        </div>
      </dialog>
    </div>
  );
}
