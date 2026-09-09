'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';
import Papa from 'papaparse';

type Option = { id: string; option_key: string; option_text: string; sort_order?: number };
type Question = {
  id: string;
  category_id: string;
  type: string;
  text: string;
  difficulty: string;
  answer: string;
  media_url?: string | null;
  media_urls?: string[] | null;
  options?: Option[];
};
type Category = { id: string; name: string };

const QUESTION_TYPES = [
  { value: 'MCQ', label: 'MCQ' },
  { value: 'PICTURE', label: 'Picture (buzzer round)' },
  { value: 'SEQUENCE', label: 'Sequencing' },
];

const VALID_TYPES = QUESTION_TYPES.map(t => t.value);
// Must match DIFFICULTY_ORDER in lib/questionSet.ts exactly (case-sensitive): a question saved
// as "easy" or "Easy " is bucketed as an unknown tier and played after Hard.
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
// The stored MCQ answer is an option KEY, compared with === at grading time. "B " or "b" — or the
// answer text instead of the letter — matches nothing, so every team is marked wrong.
const VALID_ANSWER_KEYS = ['A', 'B', 'C', 'D'];

type FormState = {
  category: string; text: string; type: string; difficulty: string;
  optionA: string; optionB: string; optionC: string; optionD: string; correct: string;
  mediaUrls: string[]; // already-uploaded image URLs kept from editing (order = display order)
  sequenceItems: string[]; // in CORRECT order — top to bottom is the right sequence
};

const EMPTY_FORM: FormState = {
  category: '', text: '', type: 'MCQ', difficulty: '',
  optionA: '', optionB: '', optionC: '', optionD: '', correct: '',
  mediaUrls: [], sequenceItems: ['', '', ''],
};

const IMAGE_BUCKET = 'question-images';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Uploads the file to Supabase Storage and returns its public URL, or null on failure.
 * The extension comes from the MIME type, not the filename: a file named "photo" with no dot
 * used to be stored as "<uuid>.photo", which Supabase then served with a content type no browser
 * renders inline — the image simply didn't appear on the projector. `accept="image/*"` on the
 * input is only a picker hint, so the type and size are checked here for real. */
async function uploadQuestionImage(file: File): Promise<string | null> {
  const ext = MIME_EXT[file.type];
  if (!ext) { alert('Please choose a JPEG, PNG, WebP or GIF image.'); return null; }
  if (file.size > MAX_IMAGE_BYTES) { alert(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — please use one under 5 MB.`); return null; }
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (error) { console.error(error); return null; }
  const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** Uploads several files in parallel and returns their public URLs in the same order as
 * `files`. Returns null (uploading nothing) if any single file fails, so a Picture question
 * never ends up half-saved with only some of its images. */
async function uploadQuestionImages(files: File[]): Promise<string[] | null> {
  const results = await Promise.all(files.map(uploadQuestionImage));
  if (results.some(url => !url)) return null;
  return results as string[];
}

// Defined at module scope (not inside QuestionBankPage) so it keeps the same component
// identity across renders — nesting it inside the page component would make React remount
// the whole form (and drop input focus) on every keystroke.
function QuestionForm({ form, setForm, mediaFiles, setMediaFiles, saving, onSubmit, onCancel, title }: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  mediaFiles: File[];
  setMediaFiles: React.Dispatch<React.SetStateAction<File[]>>;
  saving: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  title: string;
}) {
  const isPicture = form.type === 'PICTURE';
  const isSequence = form.type === 'SEQUENCE';
  // Object URLs for the not-yet-uploaded files chosen this session, alongside the URLs of
  // images already saved on the question (kept across edits unless removed below).
  const pendingPreviews = mediaFiles.map(f => URL.createObjectURL(f));

  function removeExistingUrl(i: number) {
    setForm(f => ({ ...f, mediaUrls: f.mediaUrls.filter((_, idx) => idx !== i) }));
  }
  function removePendingFile(i: number) {
    setMediaFiles(prev => prev.filter((_, idx) => idx !== i));
  }
  function addFiles(newFiles: FileList | null) {
    if (!newFiles || newFiles.length === 0) return;
    // Copy out of the live FileList RIGHT HERE, synchronously — not inside the setState updater
    // below. `newFiles` stays tied to the <input>'s current files; the onChange handler resets
    // input.value = '' immediately after calling this (so the same file can be re-picked later),
    // which clears that live FileList out from under us. React doesn't run a functional updater
    // until slightly after this function returns, so `Array.from(newFiles)` evaluated inside the
    // updater saw an already-emptied list — the picked file vanished before it was ever copied,
    // and the count never moved past whatever was already attached.
    const picked = Array.from(newFiles);
    // Append rather than replace: choosing files is a separate action each time the file
    // picker opens, and a second pick used to wipe out the first — you could only ever attach
    // one batch's worth of images per click of "choose files" instead of building up a set.
    setMediaFiles(prev => [...prev, ...picked]);
  }

  function updateItem(i: number, value: string) {
    setForm(f => ({ ...f, sequenceItems: f.sequenceItems.map((s, idx) => (idx === i ? value : s)) }));
  }
  function addItem() {
    setForm(f => ({ ...f, sequenceItems: [...f.sequenceItems, ''] }));
  }
  function removeItem(i: number) {
    setForm(f => ({ ...f, sequenceItems: f.sequenceItems.filter((_, idx) => idx !== i) }));
  }
  function moveItem(i: number, dir: -1 | 1) {
    setForm(f => {
      const arr = [...f.sequenceItems];
      const j = i + dir;
      if (j < 0 || j >= arr.length) return f;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...f, sequenceItems: arr };
    });
  }
  return (
    <form onSubmit={onSubmit} className="p-8 flex flex-col gap-6">
      <h3 className="text-2xl font-bold text-gray-900">{title}</h3>
      <div className="grid grid-cols-2 gap-4">
        <select className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
          value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
          {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input required placeholder="Category name" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
          value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} />
        {/* A dropdown, not free text: difficulty is matched case-sensitively when ordering the
            round's tiers, so a typed "easy" or "Easy " played out of order. */}
        <select required className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
          value={form.difficulty} onChange={e => setForm(f => ({ ...f, difficulty: e.target.value }))}>
          <option value="">— select difficulty —</option>
          {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <textarea required placeholder={isPicture ? 'Prompt (e.g. "Identify this landmark")' : 'Question text'}
          className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500" rows={3}
          value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))} />

        {isPicture ? (
          <>
            <div className="col-span-2 flex flex-col gap-3">
              <label className="text-sm font-semibold text-gray-700">
                Question Images {(form.mediaUrls.length + mediaFiles.length) > 0 && (
                  <span className="font-normal text-gray-500">({form.mediaUrls.length + mediaFiles.length} attached)</span>
                )}
              </label>
              <input type="file" accept="image/*" multiple className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
                onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
              <p className="text-xs text-gray-500 -mt-1">Select multiple images at once, or click again to add more. They'll display in the order shown below.</p>
              {(form.mediaUrls.length > 0 || pendingPreviews.length > 0) && (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {form.mediaUrls.map((url, i) => (
                    <div key={`existing-${url}`} className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" className="w-full h-24 rounded-lg border-2 border-gray-300 object-cover" />
                      <button type="button" onClick={() => removeExistingUrl(i)}
                        className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-bold flex items-center justify-center shadow-md">✕</button>
                    </div>
                  ))}
                  {pendingPreviews.map((url, i) => (
                    <div key={`pending-${i}`} className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" className="w-full h-24 rounded-lg border-2 border-blue-300 object-cover" />
                      <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded">new</span>
                      <button type="button" onClick={() => removePendingFile(i)}
                        className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-bold flex items-center justify-center shadow-md">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <input required placeholder="Reference answer (host only — for judging buzzes)" className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.correct} onChange={e => setForm(f => ({ ...f, correct: e.target.value }))} />
          </>
        ) : isSequence ? (
          <div className="col-span-2 flex flex-col gap-3">
            <label className="text-sm font-semibold text-gray-700">Sequence Items (in CORRECT order — top = first)</label>
            {form.sequenceItems.map((item, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-50 p-4 rounded-lg border border-gray-200">
                <span className="text-sm font-bold text-gray-500 w-6 text-center">{i + 1}</span>
                <input required placeholder={`Item ${i + 1}`} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900"
                  value={item} onChange={e => updateItem(i, e.target.value)} />
                <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0}
                  className="text-blue-600 disabled:opacity-30 hover:text-blue-700 font-bold px-3 py-2">↑</button>
                <button type="button" onClick={() => moveItem(i, 1)} disabled={i === form.sequenceItems.length - 1}
                  className="text-blue-600 disabled:opacity-30 hover:text-blue-700 font-bold px-3 py-2">↓</button>
                <button type="button" onClick={() => removeItem(i)} disabled={form.sequenceItems.length <= 2}
                  className="text-red-600 disabled:opacity-30 hover:text-red-700 font-bold px-3 py-2 text-lg">✕</button>
              </div>
            ))}
            <button type="button" onClick={addItem} className="text-blue-600 hover:text-blue-700 font-semibold text-sm mt-2 px-4 py-2 bg-blue-50 rounded-lg">+ Add Item</button>
          </div>
        ) : (
          <>
            <input required placeholder="Option A" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.optionA} onChange={e => setForm(f => ({ ...f, optionA: e.target.value }))} />
            <input required placeholder="Option B" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.optionB} onChange={e => setForm(f => ({ ...f, optionB: e.target.value }))} />
            <input required placeholder="Option C" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.optionC} onChange={e => setForm(f => ({ ...f, optionC: e.target.value }))} />
            <input required placeholder="Option D" className="px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.optionD} onChange={e => setForm(f => ({ ...f, optionD: e.target.value }))} />
            <input required placeholder="Correct answer (A/B/C/D)" className="col-span-2 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
              value={form.correct} onChange={e => setForm(f => ({ ...f, correct: e.target.value.toUpperCase() }))} />
          </>
        )}
      </div>
      <div className="flex justify-end gap-3 pt-6">
        <button type="button" className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors shadow-md">
          {saving ? 'Saving…' : 'Save Question'}
        </button>
      </div>
    </form>
  );
}

export default function QuestionBankPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  // ── form state shared by Add and Edit modals ──────────────────
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── search + sort (243+ questions means scrolling to find one is a real problem) ─────────
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'text' | 'type' | 'difficulty' | 'category' | 'answer'>('text');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(key: typeof sortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const DIFFICULTY_RANK: Record<string, number> = { Easy: 0, Medium: 1, Hard: 2 };

  // Category name isn't on the question row itself (only category_id), so it's looked up once
  // here rather than inside the sort comparator, which would otherwise re-run categories.find()
  // for every pairwise comparison during the sort.
  const visibleQuestions = useMemo(() => {
    const withCategoryName = questions.map(q => ({ q, categoryName: categories.find(c => c.id === q.category_id)?.name || '' }));

    const term = search.trim().toLowerCase();
    const filtered = term
      ? withCategoryName.filter(({ q, categoryName }) =>
          q.text.toLowerCase().includes(term) ||
          categoryName.toLowerCase().includes(term) ||
          (q.answer || '').toLowerCase().includes(term))
      : withCategoryName;

    const dir = sortDir === 'asc' ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'text') cmp = a.q.text.localeCompare(b.q.text);
      else if (sortKey === 'type') cmp = a.q.type.localeCompare(b.q.type);
      else if (sortKey === 'difficulty') cmp = (DIFFICULTY_RANK[a.q.difficulty] ?? 99) - (DIFFICULTY_RANK[b.q.difficulty] ?? 99);
      else if (sortKey === 'category') cmp = a.categoryName.localeCompare(b.categoryName);
      else if (sortKey === 'answer') cmp = (a.q.answer || '').localeCompare(b.q.answer || '');
      return cmp * dir;
    });
    return sorted.map(({ q }) => q);
  }, [questions, categories, search, sortKey, sortDir]);

  const addModalRef = useRef<HTMLDialogElement>(null);
  const editModalRef = useRef<HTMLDialogElement>(null);
  const deleteModalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    setLoading(true);
    // .range() past the default 1000-row cap: without it, once the bank grew past 1000 questions
    // the extras simply stopped appearing here, with no error — they look deleted, and get
    // re-imported.
    const [{ data: qs, error: qErr }, { data: cats }] = await Promise.all([
      supabase.from('questions').select('*, question_options(id,option_key,option_text,sort_order)').order('text').range(0, 9999),
      supabase.from('categories').select('id,name').order('name').range(0, 4999),
    ]);
    // A failed load must not look like an empty bank.
    if (qErr) { setLoading(false); alert(`Could not load the question bank: ${qErr.message}`); return; }
    setQuestions((qs as any[]) || []);
    setCategories(cats || []);
    setLoading(false);
  }

  // ── helpers ──────────────────────────────────────────────────
  // Matches trimmed + case-insensitively so "Business", " business ", "BUSINESS" from a
  // CSV import (or a typo in the Add form) don't create separate duplicate category rows.
  async function ensureCategory(rawName: string, cache?: Map<string, string>): Promise<string | null> {
    const name = (rawName || '').trim();
    if (!name) return null;
    const key = name.toLowerCase();

    // The cache is what makes CSV import work. `categories` is React state captured in the
    // import loop's closure, so it never updates mid-loop — every row of a 200-row import saw the
    // pre-import list, missed the category it had just created, and inserted it again. A file with
    // 5 categories produced 200 category rows, each holding one question, which then broke
    // question-set generation because no category had enough questions in it.
    if (cache?.has(key)) return cache.get(key)!;
    const existing = categories.find(c => c.name.trim().toLowerCase() === key);
    if (existing) { cache?.set(key, existing.id); return existing.id; }

    // Re-check the database as well, in case this run already created it.
    const { data: found } = await supabase.from('categories').select('id').ilike('name', name).limit(1).maybeSingle();
    if (found) { cache?.set(key, found.id); return found.id; }

    const { data, error } = await supabase.from('categories').insert({ name }).select().single();
    if (error) { console.error(error); return null; }
    cache?.set(key, data.id);
    setCategories(prev => [...prev, data]);
    return data.id;
  }

  function optionsFromForm() {
    return [
      { option_key: 'A', option_text: form.optionA },
      { option_key: 'B', option_text: form.optionB },
      { option_key: 'C', option_text: form.optionC },
      { option_key: 'D', option_text: form.optionD },
    ];
  }

  // Sequence items are stored as question_options too — sort_order 1..N IS the correct order,
  // so grading just compares a team's submitted key order against options sorted by sort_order.
  function sequenceOptionsFromForm() {
    return form.sequenceItems
      .map((text, i) => ({ option_key: String(i + 1), option_text: text.trim(), sort_order: i + 1 }))
      .filter(o => o.option_text.length > 0);
  }

  /** Returns an error message if the form can't be saved as a playable question, else null.
   * Each of these used to be saveable and only failed on stage: an MCQ whose answer key matches
   * no option marks every team wrong; a 1-item sequence can never be graded correct; a Picture
   * question with no picture shows a prompt and blank space on the projector. */
  function validateForm(): string | null {
    if (!form.text.trim()) return 'The question text is required.';
    if (!DIFFICULTIES.includes(form.difficulty)) return `Difficulty must be one of: ${DIFFICULTIES.join(', ')}.`;
    if (form.type === 'MCQ') {
      const correct = form.correct.trim().toUpperCase();
      if (!VALID_ANSWER_KEYS.includes(correct)) return 'The correct answer must be exactly A, B, C or D.';
      if ([form.optionA, form.optionB, form.optionC, form.optionD].some(o => !o.trim())) return 'All four options are required.';
    }
    if (form.type === 'SEQUENCE') {
      const items = sequenceOptionsFromForm();
      if (items.length < 2) return 'A sequencing question needs at least 2 non-empty items.';
      if (new Set(items.map(i => i.option_text.toLowerCase())).size !== items.length) {
        return 'Sequence items must be unique — duplicates make more than one order correct.';
      }
    }
    if (form.type === 'PICTURE' && mediaFiles.length === 0 && form.mediaUrls.length === 0) return 'Picture questions need at least one image.';
    return null;
  }

  // ── Add ──────────────────────────────────────────────────────
  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateForm();
    if (invalid) { alert(invalid); return; }
    setSaving(true);
    const categoryId = await ensureCategory(form.category);
    if (!categoryId) { setSaving(false); alert('Could not save the category for this question.'); return; }

    let mediaUrls: string[] = form.mediaUrls;
    if (form.type === 'PICTURE' && mediaFiles.length > 0) {
      const uploaded = await uploadQuestionImages(mediaFiles);
      if (!uploaded) { setSaving(false); alert('One or more images failed to upload. Check the question-images storage bucket exists (migration_009) and try again.'); return; }
      mediaUrls = [...mediaUrls, ...uploaded];
    }

    const { data: q, error: qErr } = await supabase.from('questions').insert({
      category_id: categoryId, type: form.type, text: form.text,
      difficulty: form.difficulty, answer: form.type === 'SEQUENCE' ? null : form.correct.trim().toUpperCase(),
      // media_url kept in sync as the first image, for any older code path that still reads the
      // single-image column; media_urls is the real source of truth going forward.
      media_url: form.type === 'PICTURE' ? (mediaUrls[0] || null) : null,
      media_urls: form.type === 'PICTURE' ? mediaUrls : [],
    }).select().single();
    if (qErr) { console.error(qErr); setSaving(false); alert(`Could not save the question: ${qErr.message}`); return; }

    if (form.type === 'MCQ' || form.type === 'SEQUENCE') {
      const rows = form.type === 'MCQ' ? optionsFromForm() : sequenceOptionsFromForm();
      const { error: optErr } = await supabase.from('question_options').insert(rows.map(o => ({ ...o, question_id: q.id })));
      // Roll the question back rather than leaving an option-less question in the active pool.
      if (optErr) {
        await supabase.from('questions').delete().eq('id', q.id);
        setSaving(false);
        alert(`Could not save the options: ${optErr.message}`);
        return;
      }
    }
    setSaving(false);
    addModalRef.current?.close();
    setForm(EMPTY_FORM);
    setMediaFiles([]);
    fetchAll();
  }

  // ── Edit open ────────────────────────────────────────────────
  function openEdit(q: Question) {
    const opts = q.options || [];
    const get = (key: string) => opts.find(o => o.option_key === key)?.option_text || '';
    const catName = categories.find(c => c.id === q.category_id)?.name || '';
    const sequenceItems = q.type === 'SEQUENCE'
      ? [...opts].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(o => o.option_text)
      : ['', '', ''];
    // Older rows only ever had the single media_url column — fall back to it as a one-image
    // array so a question saved before this migration still shows its picture when re-opened.
    const existingUrls = (q.media_urls && q.media_urls.length > 0) ? q.media_urls : (q.media_url ? [q.media_url] : []);
    setForm({
      category: catName, text: q.text, type: q.type,
      difficulty: q.difficulty, correct: q.answer ?? '', // SEQUENCE rows store null — never feed null to a controlled input
      optionA: get('A'), optionB: get('B'), optionC: get('C'), optionD: get('D'),
      mediaUrls: existingUrls,
      sequenceItems: sequenceItems.length >= 2 ? sequenceItems : ['', '', ''],
    });
    setMediaFiles([]);
    setEditingId(q.id);
    editModalRef.current?.showModal();
  }

  // ── Edit save ────────────────────────────────────────────────
  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const invalid = validateForm();
    if (invalid) { alert(invalid); return; }

    // Editing a question that's already locked into a set rewrites its options, while the set
    // holds a frozen copy of the option order — so changing the number of sequence items (or the
    // question type) leaves that set pointing at options that no longer exist, and every team
    // grades as wrong.
    const { count } = await supabase.from('question_set_items')
      .select('id', { count: 'exact', head: true }).eq('question_id', editingId);
    if (count && count > 0 && !confirm(`This question is already in ${count} generated question set${count === 1 ? '' : 's'}. Changing its options or type will break those sets — regenerate them afterwards. Continue?`)) return;

    setSaving(true);

    const categoryId = await ensureCategory(form.category);
    if (!categoryId) { setSaving(false); alert('Could not save the category for this question.'); return; }

    let mediaUrls: string[] = form.mediaUrls;
    if (form.type === 'PICTURE' && mediaFiles.length > 0) {
      const uploaded = await uploadQuestionImages(mediaFiles);
      if (!uploaded) { setSaving(false); alert('One or more images failed to upload. Check the question-images storage bucket exists (migration_009) and try again.'); return; }
      mediaUrls = [...mediaUrls, ...uploaded];
    }

    const { error: qErr } = await supabase.from('questions').update({
      category_id: categoryId, type: form.type, text: form.text,
      difficulty: form.difficulty, answer: form.type === 'SEQUENCE' ? null : form.correct.trim().toUpperCase(),
      media_url: form.type === 'PICTURE' ? (mediaUrls[0] || null) : null,
      media_urls: form.type === 'PICTURE' ? mediaUrls : [],
    }).eq('id', editingId);
    if (qErr) { console.error(qErr); setSaving(false); alert(`Could not save the question: ${qErr.message}`); return; }

    if (form.type === 'MCQ' || form.type === 'SEQUENCE') {
      // Replace options: delete old, insert new
      await supabase.from('question_options').delete().eq('question_id', editingId);
      const rows = form.type === 'MCQ' ? optionsFromForm() : sequenceOptionsFromForm();
      const { error: optErr } = await supabase.from('question_options').insert(rows.map(o => ({ ...o, question_id: editingId })));
      if (optErr) { setSaving(false); alert(`The question saved but its options did NOT: ${optErr.message}\n\nRe-open and save it again.`); return; }
    } else {
      await supabase.from('question_options').delete().eq('question_id', editingId);
    }

    setSaving(false);
    editModalRef.current?.close();
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMediaFiles([]);
    fetchAll();
  }

  // ── Delete ───────────────────────────────────────────────────
  function openDelete(id: string) {
    setDeleteId(id);
    deleteModalRef.current?.showModal();
  }

  async function handleDelete() {
    if (!deleteId) return;
    // A question that's already inside a generated question set can't just be deleted: doing so
    // used to silently remove it from that (possibly locked) set, so a round would quietly play
    // one question short on the night. Check first and say so.
    const { count } = await supabase.from('question_set_items')
      .select('id', { count: 'exact', head: true }).eq('question_id', deleteId);
    if (count && count > 0) {
      deleteModalRef.current?.close();
      setDeleteId(null);
      alert(`This question is used in ${count} generated question set${count === 1 ? '' : 's'}. Unlock and regenerate those rounds first, or set the question to archived instead of deleting it.`);
      return;
    }
    // question_options cascade-deletes due to ON DELETE CASCADE in schema
    const { error } = await supabase.from('questions').delete().eq('id', deleteId);
    if (error) { alert(`Delete failed: ${error.message}`); return; }
    deleteModalRef.current?.close();
    setDeleteId(null);
    fetchAll();
  }

  // ── CSV Import ───────────────────────────────────────────────
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.replace(/^﻿/, ''),
      complete: async (results) => {
        const rows = results.data as any[];
        // One cache for the whole import — see ensureCategory.
        const catCache = new Map<string, string>(categories.map(c => [c.name.trim().toLowerCase(), c.id] as const));
        const skipped: string[] = [];
        let imported = 0;

        for (const row of rows) {
          const label = String(row.Question || '(no text)').slice(0, 50);
          const type = String(row['Question Type'] || '').trim().toUpperCase();
          const difficulty = String(row.Difficulty || '').trim();
          const answer = String(row['Correct Answer'] || '').trim().toUpperCase();

          // Validate BEFORE inserting. Previously a bad row still created the question and only
          // skipped its options, leaving an MCQ with nothing to choose from sitting in the
          // active pool — it would then be generated into a round and shown on the big screen
          // with no answers. A mistyped type ("mcq") saved fine too, but was invisible to the
          // generator (which matches on the exact type) — questions you can see but can't use.
          if (!VALID_TYPES.includes(type)) { skipped.push(`${label} — unknown type "${row['Question Type']}"`); continue; }
          if (!row.Question?.trim()) { skipped.push(`${label} — no question text`); continue; }
          if (!DIFFICULTIES.includes(difficulty)) { skipped.push(`${label} — unknown difficulty "${row.Difficulty}"`); continue; }

          const opts = [
            { option_key: 'A', option_text: row['Option A'] },
            { option_key: 'B', option_text: row['Option B'] },
            { option_key: 'C', option_text: row['Option C'] },
            { option_key: 'D', option_text: row['Option D'] },
          ];
          if (type === 'MCQ') {
            if (opts.some(o => !o.option_text?.trim())) { skipped.push(`${label} — a blank option`); continue; }
            if (!VALID_ANSWER_KEYS.includes(answer)) { skipped.push(`${label} — correct answer must be A, B, C or D (got "${row['Correct Answer']}")`); continue; }
          }

          const catId = await ensureCategory(row.Category, catCache);
          if (!catId) { skipped.push(`${label} — category "${row.Category}" could not be created`); continue; }

          const { data: q, error: qErr } = await supabase.from('questions').insert({
            category_id: catId, type, text: row.Question, difficulty,
            answer: type === 'SEQUENCE' ? null : answer,
          }).select().single();
          if (qErr) { skipped.push(`${label} — ${qErr.message}`); continue; }

          if (type === 'MCQ') {
            const { error: optErr } = await supabase.from('question_options').insert(opts.map(o => ({ ...o, question_id: q.id })));
            if (optErr) { await supabase.from('questions').delete().eq('id', q.id); skipped.push(`${label} — options failed to save`); continue; }
          }
          imported++;
        }

        fetchAll();
        setImporting(false);
        // reset file input so the same file can be re-imported if needed
        e.target.value = '';
        alert(skipped.length === 0
          ? `Imported ${imported} question${imported === 1 ? '' : 's'}.`
          : `Imported ${imported} of ${rows.length}. Skipped ${skipped.length}:\n\n${skipped.slice(0, 20).join('\n')}${skipped.length > 20 ? `\n…and ${skipped.length - 20} more` : ''}`);
      },
    });
  }

  function closeModals() {
    addModalRef.current?.close();
    editModalRef.current?.close();
  }

  // ── render ───────────────────────────────────────────────────
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-lg">
      {/* Toolbar */}
      <div className="flex justify-between items-center px-8 py-6 border-b border-gray-200">
        <h2 className="text-2xl font-bold text-gray-900">Question Bank
          <span className="ml-3 text-lg font-normal text-gray-500">
            ({visibleQuestions.length === questions.length ? `${questions.length} questions` : `${visibleQuestions.length} of ${questions.length}`})
          </span>
        </h2>
        <div className="flex gap-3">
          <label className={`bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white px-6 py-3 rounded-lg cursor-pointer text-sm font-semibold shadow-md hover:shadow-lg transition-all ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
            {importing ? 'Importing…' : '📥 Import CSV'}
            <input type="file" accept=".csv" className="hidden" onChange={handleImport} disabled={importing} />
          </label>
          <button
            className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            onClick={() => { setForm(EMPTY_FORM); setMediaFiles([]); addModalRef.current?.showModal(); }}>
            + Add Question
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-8 py-4 border-b border-gray-200 bg-gray-50">
        <div className="relative max-w-md">
          <input
            type="text"
            placeholder="🔎 Search by question text, category, or answer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-4 py-2.5 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500 bg-white"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 font-bold">✕</button>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <p className="p-8 text-gray-600 text-center">Loading questions…</p>
      ) : questions.length === 0 ? (
        <p className="p-8 text-gray-600 text-center">No questions yet. Add one or import a CSV.</p>
      ) : visibleQuestions.length === 0 ? (
        <p className="p-8 text-gray-600 text-center">No questions match "{search}".</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gradient-to-r from-gray-900 to-gray-800 border-b text-white text-xs font-semibold tracking-wider">
              <tr>
                {([
                  ['text', 'Question'],
                  ['type', 'Type'],
                  ['difficulty', 'Difficulty'],
                  ['category', 'Category'],
                  ['answer', 'Answer Key'],
                ] as const).map(([key, label]) => (
                  <th key={key} onClick={() => toggleSort(key)}
                    className="px-6 py-4 cursor-pointer select-none hover:bg-white/10 transition-colors">
                    <span className="inline-flex items-center gap-1">
                      {label}
                      <span className="text-[10px] opacity-70">{sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                    </span>
                  </th>
                ))}
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {visibleQuestions.map((q, idx) => (
                <tr key={q.id} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors`}>
                  <td className="px-6 py-4 max-w-sm">
                    <div className="flex items-center gap-3">
                      {q.type === 'PICTURE' && (q.media_urls?.[0] || q.media_url) && (
                        <div className="relative shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={q.media_urls?.[0] || q.media_url!} alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-300" />
                          {(q.media_urls?.length || 0) > 1 && (
                            <span className="absolute -bottom-1 -right-1 bg-purple-600 text-white text-[9px] font-bold px-1 rounded-full leading-tight">
                              +{q.media_urls!.length - 1}
                            </span>
                          )}
                        </div>
                      )}
                      <span className="truncate text-gray-900 font-medium" title={q.text}>{q.text}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold ${
                      q.type === 'MCQ' ? 'bg-blue-100 text-blue-800' :
                      q.type === 'PICTURE' ? 'bg-purple-100 text-purple-800' :
                      'bg-teal-100 text-teal-800'
                    }`}>{QUESTION_TYPES.find(t => t.value === q.type)?.label || q.type}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold ${
                      q.difficulty === 'Easy' ? 'bg-green-100 text-green-800' :
                      q.difficulty === 'Medium' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-red-100 text-red-800'
                    }`}>{q.difficulty}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-700 font-medium">{categories.find(c => c.id === q.category_id)?.name || '—'}</td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-700 bg-gray-100 px-3 py-2 rounded inline-block">
                    {q.type === 'SEQUENCE'
                      ? (q.options || []).length > 0
                        ? [...q.options!].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(o => o.option_text).join(' → ')
                        : '—'
                      : q.answer}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => openEdit(q)}
                        className="inline-flex px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">Edit</button>
                      <button onClick={() => openDelete(q.id)}
                        className="inline-flex px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 rounded-md hover:bg-red-100 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      <dialog ref={addModalRef} className="w-full max-w-2xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <QuestionForm form={form} setForm={setForm} mediaFiles={mediaFiles} setMediaFiles={setMediaFiles} saving={saving} onSubmit={handleAdd} onCancel={closeModals} title="New Question" />
      </dialog>

      {/* Edit modal */}
      <dialog ref={editModalRef} className="w-full max-w-2xl rounded-2xl shadow-2xl backdrop:bg-black/50">
        <QuestionForm form={form} setForm={setForm} mediaFiles={mediaFiles} setMediaFiles={setMediaFiles} saving={saving} onSubmit={handleEdit} onCancel={closeModals} title="Edit Question" />
      </dialog>

      {/* Delete confirm modal */}
      <dialog ref={deleteModalRef} className="rounded-2xl shadow-2xl p-8 max-w-sm backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Delete question?</h3>
        <p className="text-gray-700 text-sm mb-8">This will also remove all its options. This cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors"
            onClick={() => deleteModalRef.current?.close()}>Cancel</button>
          <button className="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors shadow-md"
            onClick={handleDelete}>Delete Question</button>
        </div>
      </dialog>
    </div>
  );
}
