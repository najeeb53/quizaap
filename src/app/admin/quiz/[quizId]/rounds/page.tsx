'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Round = {
  id: string;
  quiz_id: string;
  sequence_no: number;
  name: string;
  round_type: string;
  question_count: number;
  marks_correct: number;
  marks_wrong: number;
  marks_skip: number;
  timer_seconds: number;
  buzzer_enabled: boolean;
  elimination_enabled: boolean;
  elimination_count: number;
  category_selection: string;
  team_picks_category: boolean;
  category_ids: string[] | null;
  status: string;
};

type Category = { id: string; name: string };

// The round type decides WHICH QUESTIONS the round draws from the bank — nothing else. Whether
// teams buzz is the separate "Enable buzzer" setting, so a picture round can equally be a buzzer
// race or the host working round the table. The stored values are unchanged (BUZZER and
// PICTURE_BUZZER are historical names); only what they promise the admin has been corrected.
const ROUND_TYPES = [
  { value: 'MCQ', label: 'MCQ — text questions' },
  { value: 'BUZZER', label: 'MCQ — text questions (alternate)' },
  { value: 'PICTURE_BUZZER', label: 'Picture — image questions' },
  { value: 'SEQUENCING', label: 'Sequencing (drag-and-drop)' },
  { value: 'RAPID_FIRE', label: 'Rapid Fire' },
];

type FormState = {
  name: string; round_type: string; question_count: string;
  marks_correct: string; marks_wrong: string; marks_skip: string;
  timer_seconds: string; buzzer_enabled: boolean;
  elimination_enabled: boolean; elimination_count: string;
  category_selection: string;
  team_picks_category: boolean;
  category_ids: string[];
};

const EMPTY_FORM: FormState = {
  name: '', round_type: 'MCQ', question_count: '10',
  marks_correct: '10', marks_wrong: '0', marks_skip: '0',
  timer_seconds: '30', buzzer_enabled: false,
  elimination_enabled: false, elimination_count: '1',
  category_selection: 'random',
  team_picks_category: false,
  category_ids: [],
};

// Module-scope so it isn't recreated (and remounted, dropping input focus) on every render.
function RoundForm({ form, setForm, saving, onSubmit, onCancel, title, categories }: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  title: string;
  categories: Category[];
}) {
  function toggleCategory(id: string) {
    setForm(f => ({
      ...f,
      category_ids: f.category_ids.includes(id) ? f.category_ids.filter(c => c !== id) : [...f.category_ids, id],
    }));
  }
  return (
    <form onSubmit={onSubmit} className="p-8 flex flex-col gap-6 max-h-[80vh] overflow-y-auto">
      <h3 className="text-2xl font-bold text-gray-900">{title}</h3>
      <div className="grid grid-cols-2 gap-4">
        <input required placeholder="Round name" className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <select className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
          value={form.round_type} onChange={e => setForm(f => ({ ...f, round_type: e.target.value }))}>
          {ROUND_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label className="text-sm text-gray-700 font-semibold">Question Count
          <input type="number" min={0} className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.question_count} onChange={e => setForm(f => ({ ...f, question_count: e.target.value }))} />
        </label>
        <label className="text-sm text-gray-700 font-semibold">Timer (seconds)
          <input type="number" min={0} className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.timer_seconds} onChange={e => setForm(f => ({ ...f, timer_seconds: e.target.value }))} />
        </label>
        <label className="text-sm text-gray-700 font-semibold">Points for Correct
          <input type="number" className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.marks_correct} onChange={e => setForm(f => ({ ...f, marks_correct: e.target.value }))} />
        </label>
        <label className="text-sm text-gray-700 font-semibold">Points for Wrong
          <input type="number" className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.marks_wrong} onChange={e => setForm(f => ({ ...f, marks_wrong: e.target.value }))} />
          <p className="text-xs text-gray-600 mt-1">Docked points (5 or -5 both work)</p>
        </label>
        <label className="text-sm text-gray-700 font-semibold">Points for Skip
          <input type="number" className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.marks_skip} onChange={e => setForm(f => ({ ...f, marks_skip: e.target.value }))} />
        </label>
        <label className="text-sm text-gray-700 font-semibold">Category Selection
          <select className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
            value={form.category_selection} onChange={e => setForm(f => ({ ...f, category_selection: e.target.value }))}>
            <option value="random">Random</option>
            <option value="manual">Admin Selected</option>
          </select>
        </label>
        <label className="flex items-start gap-3 text-sm text-gray-700 col-span-2 bg-blue-50 p-3 rounded-lg border border-blue-200">
          <input type="checkbox" checked={form.team_picks_category} className="mt-1"
            onChange={e => setForm(f => ({ ...f, team_picks_category: e.target.checked }))} />
          <span><strong>Teams choose category (turn-based)</strong> — the team whose turn it is picks which category to play next</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-gray-700 col-span-2 bg-yellow-50 p-3 rounded-lg border border-yellow-200">
          <input type="checkbox" checked={form.buzzer_enabled} className="mt-1"
            onChange={e => setForm(f => ({ ...f, buzzer_enabled: e.target.checked }))} />
          <span>
            <strong>Enable buzzer</strong> for this round
            <em className="block not-italic text-xs text-gray-500 mt-1">
              On: teams race to buzz in, and the buzz decides who answers. Off: the host asks the
              teams in seating order and records the result.
            </em>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm text-gray-700 col-span-2 bg-red-50 p-3 rounded-lg border border-red-200">
          <input type="checkbox" checked={form.elimination_enabled} className="mt-1"
            onChange={e => setForm(f => ({ ...f, elimination_enabled: e.target.checked }))} />
          <span><strong>Eliminate team(s)</strong> after this round</span>
        </label>
        {form.elimination_enabled && (
          <label className="text-sm text-gray-700 font-semibold">Number of Teams to Eliminate
            <input type="number" min={1} className="border-2 border-gray-300 rounded-lg px-4 py-3 w-full mt-2 focus:border-blue-500 focus:outline-none text-gray-900"
              value={form.elimination_count} onChange={e => setForm(f => ({ ...f, elimination_count: e.target.value }))} />
          </label>
        )}
        <div className="col-span-2">
          <p className="text-sm font-semibold text-gray-700 mb-3">
            Categories in Play
            <span className="text-gray-600 font-normal ml-2">(leave unchecked for all categories)</span>
          </p>
          {categories.length === 0 ? (
            <p className="text-sm text-gray-600 bg-gray-50 p-4 rounded-lg border border-gray-200">No categories yet — add some in the Question Bank first.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 border-2 border-gray-300 rounded-lg p-4 max-h-40 overflow-y-auto bg-gray-50">
              {categories.map(c => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-gray-700 bg-white p-2 rounded hover:bg-blue-50 transition-colors">
                  <input type="checkbox" checked={form.category_ids.includes(c.id)} onChange={() => toggleCategory(c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-4">
        <button type="button" className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors shadow-md">
          {saving ? 'Saving…' : 'Save Round'}
        </button>
      </div>
    </form>
  );
}

export default function RoundsPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addModalRef = useRef<HTMLDialogElement>(null);
  const editModalRef = useRef<HTMLDialogElement>(null);
  const deleteModalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    fetchRounds();
    supabase.from('categories').select('id, name').order('name').then(({ data }) => setCategories(data || []));
  }, [quizId]);

  async function fetchRounds() {
    setLoading(true);
    const { data, error } = await supabase.from('rounds').select('*').eq('quiz_id', quizId).order('sequence_no');
    if (error) console.error(error);
    setRounds(data || []);
    setLoading(false);
  }

  function formToPayload() {
    return {
      name: form.name,
      round_type: form.round_type,
      question_count: Number(form.question_count) || 0,
      marks_correct: Number(form.marks_correct) || 0,
      marks_wrong: Number(form.marks_wrong) || 0,
      marks_skip: Number(form.marks_skip) || 0,
      timer_seconds: Number(form.timer_seconds) || 0,
      // Saved exactly as ticked. This used to be forced true for the BUZZER and PICTURE_BUZZER
      // types, so unticking it on those rounds silently reverted — and there was no way at all to
      // run a picture round without a buzzer, even though the two are unrelated choices.
      buzzer_enabled: form.buzzer_enabled,
      elimination_enabled: form.elimination_enabled,
      elimination_count: Number(form.elimination_count) || 0,
      category_selection: form.category_selection,
      team_picks_category: form.team_picks_category,
      category_ids: form.category_ids.length > 0 ? form.category_ids : null,
    };
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const nextSeq = rounds.length > 0 ? Math.max(...rounds.map(r => r.sequence_no)) + 1 : 1;
    const { error } = await supabase.from('rounds').insert({
      quiz_id: quizId, sequence_no: nextSeq, ...formToPayload(),
    });
    setSaving(false);
    // Surfaced, not swallowed: a failed insert used to just close the modal with no round added
    // and no explanation (this is exactly how a missing `category_ids` column would present).
    if (error) { console.error(error); alert(`Could not save the round: ${error.message}`); return; }
    addModalRef.current?.close();
    setForm(EMPTY_FORM);
    fetchRounds();
  }

  function openEdit(r: Round) {
    setForm({
      name: r.name, round_type: r.round_type, question_count: String(r.question_count ?? 10),
      marks_correct: String(r.marks_correct ?? 10), marks_wrong: String(r.marks_wrong ?? 0),
      marks_skip: String(r.marks_skip ?? 0), timer_seconds: String(r.timer_seconds ?? 30),
      buzzer_enabled: !!r.buzzer_enabled, elimination_enabled: !!r.elimination_enabled,
      elimination_count: String(r.elimination_count ?? 1), category_selection: r.category_selection || 'random',
      team_picks_category: !!r.team_picks_category,
      category_ids: r.category_ids || [],
    });
    setEditingId(r.id);
    editModalRef.current?.showModal();
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setSaving(true);
    const { error } = await supabase.from('rounds').update(formToPayload()).eq('id', editingId);
    setSaving(false);
    if (error) { console.error(error); alert(`Could not save the round: ${error.message}`); return; }
    editModalRef.current?.close();
    setEditingId(null);
    setForm(EMPTY_FORM);
    fetchRounds();
  }

  function openDelete(id: string) {
    setDeleteId(id);
    deleteModalRef.current?.showModal();
  }

  async function handleDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from('rounds').delete().eq('id', deleteId);
    // A round that's been played is referenced by a live session, so the delete is refused. The
    // error used to be discarded, so the dialog closed and the round stayed in the list — you
    // could click Delete all day and nothing would happen or explain itself.
    if (error) {
      alert(error.code === '23503'
        ? 'This round is part of a live session and cannot be deleted. End or reset that session first.'
        : `Delete failed: ${error.message}`);
      return;
    }
    deleteModalRef.current?.close();
    setDeleteId(null);
    fetchRounds();
  }

  async function moveRound(round: Round, direction: -1 | 1) {
    const sorted = [...rounds].sort((a, b) => a.sequence_no - b.sequence_no);
    const idx = sorted.findIndex(r => r.id === round.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    await Promise.all([
      supabase.from('rounds').update({ sequence_no: other.sequence_no }).eq('id', round.id),
      supabase.from('rounds').update({ sequence_no: round.sequence_no }).eq('id', other.id),
    ]);
    fetchRounds();
  }

  function closeModals() {
    addModalRef.current?.close();
    editModalRef.current?.close();
  }

  const sortedRounds = [...rounds].sort((a, b) => a.sequence_no - b.sequence_no);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-lg">
      <div className="flex justify-between items-center px-8 py-6 border-b border-gray-200">
        <h3 className="text-2xl font-bold text-gray-900">Rounds
          <span className="ml-3 text-lg font-normal text-gray-500">({rounds.length})</span>
        </h3>
        <button
          className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all"
          onClick={() => { setForm(EMPTY_FORM); addModalRef.current?.showModal(); }}>
          + Add Round
        </button>
      </div>

      {loading ? (
        <p className="p-8 text-gray-600 text-center">Loading rounds…</p>
      ) : sortedRounds.length === 0 ? (
        <p className="p-8 text-gray-600 text-center">No rounds yet. Add one to get started.</p>
      ) : (
        <ul className="divide-y divide-gray-200">
          {sortedRounds.map((r, i) => (
            <li key={r.id} className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} px-8 py-5 flex items-center justify-between gap-6 hover:bg-blue-50 transition-colors`}>
              <div className="flex items-center gap-6 flex-1">
                <div className="flex flex-col">
                  <button disabled={i === 0} onClick={() => moveRound(r, -1)} className="text-gray-500 hover:text-blue-600 disabled:opacity-20 text-lg font-bold" title="Move up">▲</button>
                  <button disabled={i === sortedRounds.length - 1} onClick={() => moveRound(r, 1)} className="text-gray-500 hover:text-blue-600 disabled:opacity-20 text-lg font-bold" title="Move down">▼</button>
                </div>
                <div className="flex-1">
                  <p className="font-bold text-lg text-gray-900">R{r.sequence_no}: {r.name}</p>
                  <p className="text-sm text-gray-600 mt-2 leading-relaxed flex flex-wrap gap-3">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-purple-100 text-purple-800 font-semibold text-xs">{ROUND_TYPES.find(t => t.value === r.round_type)?.label || r.round_type}</span>
                    <span className="text-gray-700"><strong>{r.question_count}</strong> questions</span>
                    <span className="text-gray-700">Points: <strong>+{r.marks_correct}</strong> / <strong>-{Math.abs(r.marks_wrong)}</strong></span>
                    <span className="text-gray-700"><strong>{r.timer_seconds}s</strong> timer</span>
                    {r.buzzer_enabled && <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-yellow-100 text-yellow-800 font-semibold text-xs">🔔 Buzzer</span>}
                    {r.team_picks_category && <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-teal-100 text-teal-800 font-semibold text-xs">🎯 Teams Pick</span>}
                    {r.elimination_enabled && <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-100 text-red-800 font-semibold text-xs">⚠️ Eliminates {r.elimination_count}</span>}
                    <span className="text-gray-700">{r.category_ids && r.category_ids.length > 0 ? `🏷️ ${r.category_ids.length} categories` : '🏷️ All categories'}</span>
                  </p>
                </div>
              </div>
              <div className="flex gap-2 text-sm shrink-0">
                <button onClick={() => openEdit(r)} className="inline-flex px-4 py-2 text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 font-semibold transition-colors">Edit</button>
                <button onClick={() => openDelete(r.id)} className="inline-flex px-4 py-2 text-red-700 bg-red-50 rounded-lg hover:bg-red-100 font-semibold transition-colors">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <dialog ref={addModalRef} className="w-full max-w-xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <RoundForm form={form} setForm={setForm} saving={saving} onSubmit={handleAdd} onCancel={closeModals} title="New Round" categories={categories} />
      </dialog>
      <dialog ref={editModalRef} className="w-full max-w-xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <RoundForm form={form} setForm={setForm} saving={saving} onSubmit={handleEdit} onCancel={closeModals} title="Edit Round" categories={categories} />
      </dialog>
      <dialog ref={deleteModalRef} className="rounded-2xl shadow-2xl p-8 max-w-sm backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Delete round?</h3>
        <p className="text-gray-700 text-sm mb-8">This cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={() => deleteModalRef.current?.close()}>Cancel</button>
          <button className="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors shadow-md" onClick={handleDelete}>Delete Round</button>
        </div>
      </dialog>
    </div>
  );
}
