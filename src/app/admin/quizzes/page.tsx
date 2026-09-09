'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

type Quiz = {
  id: string;
  name: string;
  edition: string | null;
  event_date: string | null;
  duration_minutes: number | null;
  number_of_teams: number | null;
  timezone: string | null;
  status: string;
  locked: boolean;
  created_at: string;
};

type FormState = {
  name: string; edition: string; event_date: string; duration_minutes: string; number_of_teams: string; timezone: string;
};

const EMPTY_FORM: FormState = {
  name: '', edition: '', event_date: '', duration_minutes: '', number_of_teams: '', timezone: 'UTC',
};

// Module-scope so it isn't recreated (and remounted, dropping input focus) on every render.
function QuizForm({ form, setForm, saving, onSubmit, onCancel, title }: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  title: string;
}) {
  return (
    <form onSubmit={onSubmit} className="p-8 flex flex-col gap-6">
      <h3 className="text-2xl font-bold text-gray-900">{title}</h3>
      <div className="grid grid-cols-2 gap-4">
        <input required placeholder="Quiz name" className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <input placeholder="Edition (e.g. 2026)" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.edition} onChange={e => setForm(f => ({ ...f, edition: e.target.value }))} />
        <input type="datetime-local" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.event_date} onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))} />
        <input type="number" min={1} placeholder="Duration (minutes)" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.duration_minutes} onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))} />
        <input type="number" min={1} placeholder="Number of teams" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.number_of_teams} onChange={e => setForm(f => ({ ...f, number_of_teams: e.target.value }))} />
        <input placeholder="Timezone (e.g. Asia/Calcutta)" className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))} />
      </div>
      <div className="flex justify-end gap-3 pt-4">
        <button type="button" className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors shadow-md">
          {saving ? 'Saving…' : 'Save Quiz'}
        </button>
      </div>
    </form>
  );
}

export default function QuizzesPage() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addModalRef = useRef<HTMLDialogElement>(null);
  const editModalRef = useRef<HTMLDialogElement>(null);
  const deleteModalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    fetchQuizzes();
  }, []);

  async function fetchQuizzes() {
    setLoading(true);
    const { data, error } = await supabase.from('quizzes').select('*').order('created_at', { ascending: false });
    if (error) console.error(error);
    setQuizzes(data || []);
    setLoading(false);
  }

  /** A <input type="datetime-local"> shows and returns LOCAL time. Slicing the stored UTC string
   * straight into it made the browser read those digits as local, and saving converted them to
   * UTC a second time — so every edit of a quiz (even just renaming it) walked the event time
   * backwards by the timezone offset. */
  function toLocalInputValue(iso: string): string {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function formToPayload() {
    return {
      name: form.name,
      edition: form.edition || null,
      event_date: form.event_date ? new Date(form.event_date).toISOString() : null,
      duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
      number_of_teams: form.number_of_teams ? Number(form.number_of_teams) : null,
      timezone: form.timezone || 'UTC',
    };
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase.from('quizzes').insert({ ...formToPayload(), status: 'draft' });
    setSaving(false);
    if (error) { console.error(error); alert(`Could not save the quiz: ${error.message}`); return; }
    addModalRef.current?.close();
    setForm(EMPTY_FORM);
    fetchQuizzes();
  }

  function openEdit(q: Quiz) {
    setForm({
      name: q.name,
      edition: q.edition || '',
      event_date: q.event_date ? toLocalInputValue(q.event_date) : '',
      duration_minutes: q.duration_minutes?.toString() || '',
      number_of_teams: q.number_of_teams?.toString() || '',
      timezone: q.timezone || 'UTC',
    });
    setEditingId(q.id);
    editModalRef.current?.showModal();
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setSaving(true);
    const { error } = await supabase.from('quizzes').update(formToPayload()).eq('id', editingId);
    setSaving(false);
    if (error) { console.error(error); return; }
    editModalRef.current?.close();
    setEditingId(null);
    setForm(EMPTY_FORM);
    fetchQuizzes();
  }

  async function handlePublish(q: Quiz) {
    await supabase.from('quizzes').update({ status: q.status === 'draft' ? 'published' : 'draft' }).eq('id', q.id);
    fetchQuizzes();
  }

  async function handleArchive(q: Quiz) {
    await supabase.from('quizzes').update({ status: 'archived' }).eq('id', q.id);
    fetchQuizzes();
  }

  async function handleDuplicate(q: Quiz) {
    // Duplicate quiz + its rounds (question sets / teams are session-specific, not copied)
    const { data: newQuiz, error } = await supabase.from('quizzes').insert({
      name: `${q.name} (Copy)`, edition: q.edition, event_date: q.event_date,
      duration_minutes: q.duration_minutes, number_of_teams: q.number_of_teams,
      timezone: q.timezone, status: 'draft',
    }).select().single();
    if (error || !newQuiz) { console.error(error); alert(`Could not duplicate the quiz: ${error?.message || 'unknown error'}`); return; }

    const { data: rounds } = await supabase.from('rounds').select('*').eq('quiz_id', q.id).order('sequence_no');
    if (rounds && rounds.length > 0) {
      const { error: roundsError } = await supabase.from('rounds').insert(rounds.map(r => {
        const { id, quiz_id, ...rest } = r;
        return { ...rest, quiz_id: newQuiz.id };
      }));
      // Otherwise the copy appears with zero rounds and nothing says why.
      if (roundsError) alert(`The quiz was copied but its rounds were not: ${roundsError.message}`);
    }
    fetchQuizzes();
  }

  function openDelete(id: string) {
    setDeleteId(id);
    deleteModalRef.current?.showModal();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await supabase.from('quizzes').delete().eq('id', deleteId);
    deleteModalRef.current?.close();
    setDeleteId(null);
    fetchQuizzes();
  }

  function closeModals() {
    addModalRef.current?.close();
    editModalRef.current?.close();
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-lg">
      <div className="flex justify-between items-center px-8 py-6 border-b border-gray-200">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Quizzes
            <span className="ml-3 text-lg font-normal text-gray-500">({quizzes.length})</span>
          </h2>
        </div>
        <button
          className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all"
          onClick={() => { setForm(EMPTY_FORM); addModalRef.current?.showModal(); }}>
          + New Quiz
        </button>
      </div>

      {loading ? (
        <p className="p-8 text-gray-600 text-center">Loading quizzes…</p>
      ) : quizzes.length === 0 ? (
        <p className="p-8 text-gray-600 text-center">No quizzes yet. Create one to get started.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gradient-to-r from-gray-900 to-gray-800 border-b text-white text-xs font-semibold tracking-wider">
              <tr>
                <th className="px-6 py-4">Quiz Name</th>
                <th className="px-6 py-4">Edition</th>
                <th className="px-6 py-4">Event Date</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Teams</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {quizzes.map((q, idx) => (
                <tr key={q.id} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors`}>
                  <td className="px-6 py-4 font-semibold text-gray-900">{q.name}</td>
                  <td className="px-6 py-4 text-gray-700">{q.edition || '—'}</td>
                  <td className="px-6 py-4 text-gray-700">{q.event_date ? new Date(q.event_date).toLocaleString() : '—'}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold ${
                      q.status === 'published' ? 'bg-green-100 text-green-800' :
                      q.status === 'archived' ? 'bg-gray-300 text-gray-800' :
                      'bg-orange-100 text-orange-800'
                    }`}>{q.status.charAt(0).toUpperCase() + q.status.slice(1)}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-700 font-medium">{q.number_of_teams ?? '—'}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Link href={`/admin/quiz/${q.id}/rounds`} className="inline-flex px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">Rounds</Link>
                      <Link href={`/admin/quiz/${q.id}/teams`} className="inline-flex px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 rounded-md hover:bg-purple-100 transition-colors">Teams</Link>
                      <Link href={`/admin/quiz/${q.id}/live`} className="inline-flex px-3 py-1.5 text-xs font-semibold text-teal-700 bg-teal-50 rounded-md hover:bg-teal-100 transition-colors">Live</Link>
                      <button onClick={() => openEdit(q)} className="inline-flex px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors">Edit</button>
                      <button onClick={() => handleDuplicate(q)} className="inline-flex px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors">Copy</button>
                      <button onClick={() => handlePublish(q)} className="inline-flex px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors">
                        {q.status === 'draft' ? 'Publish' : 'Unpub'}
                      </button>
                      {q.status !== 'archived' && (
                        <button onClick={() => handleArchive(q)} className="inline-flex px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors">Archive</button>
                      )}
                      <button onClick={() => openDelete(q.id)} className="inline-flex px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 rounded-md hover:bg-red-100 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dialog ref={addModalRef} className="w-full max-w-xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <QuizForm form={form} setForm={setForm} saving={saving} onSubmit={handleAdd} onCancel={closeModals} title="New Quiz" />
      </dialog>

      <dialog ref={editModalRef} className="w-full max-w-xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <QuizForm form={form} setForm={setForm} saving={saving} onSubmit={handleEdit} onCancel={closeModals} title="Edit Quiz" />
      </dialog>

      <dialog ref={deleteModalRef} className="rounded-2xl shadow-2xl p-8 max-w-sm backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Delete quiz?</h3>
        <p className="text-gray-700 text-sm mb-8">This will also remove its rounds, teams and sessions. This cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={() => deleteModalRef.current?.close()}>Cancel</button>
          <button className="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors shadow-md" onClick={handleDelete}>Delete Quiz</button>
        </div>
      </dialog>
    </div>
  );
}
