import { supabase } from './supabaseClient';

export type GeneratedItem = {
  question_id: string | null;
  category_id: string | null;
  display_order: number;
  option_order: string[];
  difficulty: string;
};

export type PoolQuestion = { id: string; category_id: string; difficulty: string };

// Fixed easy → hard progression. Anything with a difficulty value outside this list
// (a typo, or a custom label) is grouped at the end under its own label.
export const DIFFICULTY_ORDER = ['Easy', 'Medium', 'Hard'];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Loads every active question's id/category/difficulty once, so the generator UI can show
 * accurate per-category-per-difficulty availability without a query per cell. Scoped to one
 * question `type` (MCQ vs PICTURE) — an MCQ round must never pull a picture question or vice
 * versa, since they're rendered and scored completely differently. */
export async function fetchActiveQuestionPool(type: string = 'MCQ'): Promise<PoolQuestion[]> {
  // Paged: Supabase caps an unbounded select at 1000 rows and reports no error, so once the
  // bank passes 1000 questions of one type the generator would silently draw from an arbitrary
  // slice of it — reporting wrong availability counts and hiding whole categories.
  const pageSize = 1000;
  const all: PoolQuestion[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('questions').select('id, category_id, difficulty')
      .eq('status', 'active').eq('type', type).order('id').range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

/** MCQ and BUZZER rounds pull MCQ questions; PICTURE_BUZZER rounds pull PICTURE questions;
 * SEQUENCING rounds pull SEQUENCE questions. */
export function questionTypeForRound(roundType: string): string {
  if (roundType === 'PICTURE_BUZZER') return 'PICTURE';
  if (roundType === 'SEQUENCING') return 'SEQUENCE';
  return 'MCQ';
}

/** counts: categoryId -> difficulty -> how many questions to pull. */
export function computeAvailability(pool: PoolQuestion[]): Record<string, Record<string, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const q of pool) {
    const cat = (map[q.category_id] ||= {});
    cat[q.difficulty] = (cat[q.difficulty] || 0) + 1;
  }
  return map;
}

/**
 * Selects `counts[categoryId][difficulty]` random questions from the given pool.
 * The result is grouped into difficulty "blocks" in DIFFICULTY_ORDER (Easy first, then
 * Medium, then Hard, then anything else) — each block is internally shuffled (across
 * categories) but blocks themselves are never interleaved, so a round plays easier
 * questions first and harder ones later, as configured.
 */
export function generateQuestionSetItems(
  pool: PoolQuestion[],
  counts: Record<string, Record<string, number>>,
  excludeQuestionIds: string[] = []
): { items: Omit<GeneratedItem, 'option_order'>[]; errors: string[] } {
  const errors: string[] = [];
  const excluded = new Set(excludeQuestionIds);

  // group pool by category+difficulty for fast sampling
  const byCell: Record<string, PoolQuestion[]> = {};
  for (const q of pool) {
    if (excluded.has(q.id)) continue;
    const key = `${q.category_id}::${q.difficulty}`;
    (byCell[key] ||= []).push(q);
  }

  // determine block order: known difficulties first (in DIFFICULTY_ORDER), then any others alphabetically
  const usedDifficulties = new Set<string>();
  for (const catCounts of Object.values(counts)) {
    for (const [diff, n] of Object.entries(catCounts)) if (n > 0) usedDifficulties.add(diff);
  }
  const extra = [...usedDifficulties].filter(d => !DIFFICULTY_ORDER.includes(d)).sort();
  const blockOrder = [...DIFFICULTY_ORDER, ...extra];

  const items: Omit<GeneratedItem, 'option_order'>[] = [];
  let order = 0;

  for (const difficulty of blockOrder) {
    const picksThisBlock: PoolQuestion[] = [];
    for (const [categoryId, catCounts] of Object.entries(counts)) {
      const need = catCounts[difficulty] || 0;
      if (need <= 0) continue;
      const available = byCell[`${categoryId}::${difficulty}`] || [];
      if (available.length < need) {
        errors.push(`Not enough ${difficulty} questions in this category: needs ${need}, only ${available.length} available.`);
        continue;
      }
      picksThisBlock.push(...shuffle(available).slice(0, need));
    }
    for (const q of shuffle(picksThisBlock)) {
      items.push({ question_id: q.id, category_id: q.category_id, display_order: ++order, difficulty });
    }
  }

  return { items, errors };
}

/**
 * For team_picks_category rounds: the admin only sets how many question "slots" the round
 * needs at each difficulty tier (e.g. Easy: 4, Medium: 4) — not which categories. Each slot is
 * saved with no category/question yet; a category and question get assigned only once a team
 * picks, at play time (see liveEngine.pickCategory). Slots are still grouped into difficulty
 * blocks (Easy first, then Medium, then Hard) so the round plays easier tiers first.
 */
export function generateTierSlots(tierCounts: Record<string, number>): { difficulty: string; display_order: number }[] {
  const used = Object.keys(tierCounts).filter(d => (tierCounts[d] || 0) > 0);
  const extra = used.filter(d => !DIFFICULTY_ORDER.includes(d)).sort();
  const blockOrder = [...DIFFICULTY_ORDER, ...extra];
  const slots: { difficulty: string; display_order: number }[] = [];
  let order = 0;
  for (const difficulty of blockOrder) {
    const n = tierCounts[difficulty] || 0;
    for (let i = 0; i < n; i++) slots.push({ difficulty, display_order: ++order });
  }
  return slots;
}

/** Fetches and shuffles MCQ option order per question (kept separate from selection since it
 * needs a DB round-trip and only matters once the final item list is settled). */
export async function attachShuffledOptionOrder(items: Omit<GeneratedItem, 'option_order'>[]): Promise<GeneratedItem[]> {
  const questionIds = items.map(i => i.question_id);
  const byQuestion: Record<string, string[]> = {};
  if (questionIds.length > 0) {
    const { data: opts } = await supabase.from('question_options').select('question_id, option_key').in('question_id', questionIds);
    for (const o of opts || []) (byQuestion[o.question_id] ||= []).push(o.option_key);
  }
  return items.map(item => ({ ...item, option_order: byQuestion[item.question_id] ? shuffle(byQuestion[item.question_id]) : [] }));
}

export async function saveQuestionSet(sessionId: string, roundId: string, items: GeneratedItem[]) {
  // remove any existing unlocked set for this round+session before regenerating
  const { data: existing } = await supabase.from('question_sets').select('id, locked_at').eq('session_id', sessionId).eq('round_id', roundId).maybeSingle();
  if (existing?.locked_at) {
    throw new Error('This round’s question set is already locked.');
  }
  if (existing) {
    // Detach the live session first: current_question_set_item_id points into this set, and the
    // FK refuses the cascade while it does. That refusal used to be discarded, after which a
    // SECOND set was created for the same round — and every later read uses .maybeSingle(), which
    // errors on two rows, so the round would load zero questions forever with no message.
    await supabase.from('live_sessions').update({ current_question_set_item_id: null }).eq('id', sessionId);
    const { error: deleteError } = await supabase.from('question_sets').delete().eq('id', existing.id); // cascades to items
    if (deleteError) throw deleteError;
  }
  const { data: set, error } = await supabase.from('question_sets').insert({
    session_id: sessionId, round_id: roundId, generation_seed: String(Date.now()),
  }).select().single();
  if (error || !set) throw error || new Error('Failed to create question set');

  if (items.length > 0) {
    const { error: itemsError } = await supabase.from('question_set_items').insert(items.map(i => ({ ...i, question_set_id: set.id })));
    // Don't leave a set with no questions in it — that locks as "0 questions" and the round has
    // nothing to play.
    if (itemsError) {
      await supabase.from('question_sets').delete().eq('id', set.id);
      throw itemsError;
    }
  }
  return set.id as string;
}

export async function lockQuestionSet(questionSetId: string) {
  const { error } = await supabase.from('question_sets').update({ locked_at: new Date().toISOString() }).eq('id', questionSetId);
  if (error) throw error;
}
