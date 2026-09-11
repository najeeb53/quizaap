'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { hashPin, randomCode, randomPin } from '@/lib/pin';
import { uploadTeamPhoto } from '@/lib/teamPhotos';
import type { TeamMember } from '@/lib/liveEngine';

type Team = {
  id: string;
  quiz_id: string;
  name: string;
  darajah: string | null;
  code: string;
  logo_url: string | null;
  status: string;
  eliminated_at: string | null;
  members: TeamMember[] | null;
};

export default function TeamsPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [darajah, setDarajah] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ code: string; pin: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDarajah, setEditDarajah] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [membersTeamId, setMembersTeamId] = useState<string | null>(null);
  const [membersDraft, setMembersDraft] = useState<TeamMember[]>([]);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberFile, setNewMemberFile] = useState<File | null>(null);
  const [savingMember, setSavingMember] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);

  const deleteModalRef = useRef<HTMLDialogElement>(null);
  const resetModalRef = useRef<HTMLDialogElement>(null);
  const membersModalRef = useRef<HTMLDialogElement>(null);
  const memberFileRef = useRef<HTMLInputElement>(null);

  const membersTeam = teams.find(t => t.id === membersTeamId) || null;

  useEffect(() => {
    fetchTeams();
  }, [quizId]);

  async function fetchTeams() {
    setLoading(true);
    const { data, error } = await supabase.from('teams').select('*').eq('quiz_id', quizId).order('name');
    if (error) console.error(error);
    setTeams(data || []);
    setLoading(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);

    let code = randomCode();
    // avoid unlikely collision with an existing team's code
    for (let i = 0; i < 5; i++) {
      const { data } = await supabase.from('teams').select('id').eq('code', code).maybeSingle();
      if (!data) break;
      code = randomCode();
    }
    const pin = randomPin();
    const pin_hash = await hashPin(pin);

    const { error } = await supabase.from('teams').insert({
      quiz_id: quizId, name: name.trim(), darajah: darajah.trim() || null, code, pin_hash, status: 'active',
    });
    setSaving(false);
    if (error) { console.error(error); alert(`Could not add the team: ${error.message}`); return; }
    setLastCreated({ code, pin });
    setName('');
    setDarajah('');
    fetchTeams();
  }

  async function handleRename(id: string) {
    if (!editName.trim()) { setEditingId(null); return; }
    const { error } = await supabase.from('teams')
      .update({ name: editName.trim(), darajah: editDarajah.trim() || null }).eq('id', id);
    if (error) { alert(`Could not save the team: ${error.message}`); return; }
    setEditingId(null);
    fetchTeams();
  }

  async function toggleActive(t: Team) {
    await supabase.from('teams').update({ status: t.status === 'active' ? 'inactive' : 'active' }).eq('id', t.id);
    fetchTeams();
  }

  function openReset(id: string) {
    setResetId(id);
    setNewPin(null);
    resetModalRef.current?.showModal();
  }

  async function handleResetPin() {
    if (!resetId) return;
    const pin = randomPin();
    const pin_hash = await hashPin(pin);
    const { error } = await supabase.from('teams').update({ pin_hash }).eq('id', resetId);
    // Only show the new PIN once it has actually saved. The dialog says it won't be shown again,
    // so displaying one from a failed write hands the team a PIN that doesn't work — and the old
    // one is gone from view too.
    if (error) { alert(`PIN reset failed: ${error.message}`); return; }
    setNewPin(pin);
  }

  function openDelete(id: string) {
    setDeleteId(id);
    deleteModalRef.current?.showModal();
  }

  async function handleDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from('teams').delete().eq('id', deleteId);
    // A team that has played is referenced by its scores and answers, so Postgres refuses the
    // delete. That error used to be thrown away, so the dialog simply closed and the team was
    // still in the list, with nothing explaining why.
    if (error) {
      alert(error.code === '23503'
        ? "This team has already taken part in a live session, so it can't be deleted. Set it to inactive instead."
        : `Delete failed: ${error.message}`);
      return;
    }
    deleteModalRef.current?.close();
    setDeleteId(null);
    fetchTeams();
  }

  function openMembers(t: Team) {
    setMembersTeamId(t.id);
    setMembersDraft(t.members || []);
    setNewMemberName('');
    setNewMemberFile(null);
    if (memberFileRef.current) memberFileRef.current.value = '';
    membersModalRef.current?.showModal();
  }

  async function handleAddMember() {
    if (!newMemberName.trim() || !newMemberFile) return;
    setSavingMember(true);
    const url = await uploadTeamPhoto(newMemberFile);
    setSavingMember(false);
    if (!url) { alert('That photo failed to upload — check the team-photos storage bucket exists (migration_015) and try again.'); return; }
    setMembersDraft(prev => [...prev, { name: newMemberName.trim(), photo_url: url }]);
    setNewMemberName('');
    setNewMemberFile(null);
    // The file input keeps the old filename otherwise, so the next member looks like it already
    // has a photo chosen when it doesn't.
    if (memberFileRef.current) memberFileRef.current.value = '';
  }

  function handleRemoveMember(idx: number) {
    setMembersDraft(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleSaveMembers() {
    if (!membersTeamId) return;
    setSavingMembers(true);
    const { error } = await supabase.from('teams').update({ members: membersDraft }).eq('id', membersTeamId);
    setSavingMembers(false);
    if (error) { alert(`Could not save the team's members: ${error.message}`); return; }
    membersModalRef.current?.close();
    setMembersTeamId(null);
    fetchTeams();
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-lg">
      <div className="px-8 py-6 border-b border-gray-200">
        <h3 className="text-2xl font-bold text-gray-900 mb-4">Teams
          <span className="ml-3 text-lg font-normal text-gray-500">({teams.length})</span>
        </h3>
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3">
          <input required placeholder="Team name — e.g. رغبة" className="flex-1 min-w-[14rem] px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
            value={name} onChange={e => setName(e.target.value)} />
          <input placeholder="Darajah — e.g. الدرجة السادسة" className="flex-1 min-w-[14rem] px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-500"
            value={darajah} onChange={e => setDarajah(e.target.value)} />
          <button type="submit" disabled={saving}
            className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:opacity-50 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow-md hover:shadow-lg transition-all">
            {saving ? 'Adding…' : '+ Add Team'}
          </button>
        </form>
        {lastCreated && (
          <div className="mt-4 bg-gradient-to-r from-green-50 to-emerald-50 border-l-4 border-green-600 rounded-lg p-4 text-sm flex items-center justify-between">
            <span className="text-gray-900">Team created — code <b className="font-mono bg-green-100 px-2 py-1 rounded text-green-800">{lastCreated.code}</b>, PIN <b className="font-mono bg-green-100 px-2 py-1 rounded text-green-800">{lastCreated.pin}</b>. Share these with the team now; the PIN won&apos;t be shown again.</span>
            <button className="text-green-700 hover:text-green-900 font-semibold ml-4" onClick={() => setLastCreated(null)}>✕</button>
          </div>
        )}
      </div>

      {loading ? (
        <p className="p-8 text-gray-600 text-center">Loading teams…</p>
      ) : teams.length === 0 ? (
        <p className="p-8 text-gray-600 text-center">No teams yet. Add one above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gradient-to-r from-gray-900 to-gray-800 border-b text-white text-xs font-semibold tracking-wider">
              <tr>
                <th className="px-6 py-4">Team Name</th>
                <th className="px-6 py-4">Access Code</th>
                <th className="px-6 py-4">Team Console</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Eliminated</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {teams.map((t, idx) => (
                <tr key={t.id} className={`${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors`}>
                  <td className="px-6 py-4">
                    {editingId === t.id ? (
                      <div className="flex flex-col gap-2">
                        <input autoFocus className="w-full px-3 py-2 border-2 border-blue-500 rounded-lg focus:outline-none text-gray-900" value={editName}
                          placeholder="Team name"
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(t.id); if (e.key === 'Escape') setEditingId(null); }} />
                        <input className="w-full px-3 py-2 border-2 border-blue-300 rounded-lg focus:outline-none focus:border-blue-500 text-gray-700 text-xs" value={editDarajah}
                          placeholder="Darajah — e.g. الدرجة السادسة"
                          onChange={e => setEditDarajah(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(t.id); if (e.key === 'Escape') setEditingId(null); }} />
                        <div className="flex gap-2">
                          <button className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold" onClick={() => handleRename(t.id)}>Save</button>
                          <button className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-xs font-semibold hover:bg-gray-50" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button className="text-left group"
                        onClick={() => { setEditingId(t.id); setEditName(t.name); setEditDarajah(t.darajah || ''); }}>
                        <span className="block font-semibold text-gray-900 group-hover:text-blue-600 group-hover:underline">{t.name}</span>
                        <span className="block text-xs text-gray-500 group-hover:text-blue-500">{t.darajah || 'Add darajah…'}</span>
                      </button>
                    )}
                  </td>
                  <td className="px-6 py-4 font-mono text-gray-700 bg-gray-100 px-3 py-2 rounded inline-block">{t.code}</td>
                  <td className="px-6 py-4">
                    <Link href={`/team/${t.code}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">
                      Open Console ↗
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold ${
                      t.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-300 text-gray-800'
                    }`}>{t.status.charAt(0).toUpperCase() + t.status.slice(1)}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-700">{t.eliminated_at ? new Date(t.eliminated_at).toLocaleTimeString() : '—'}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => toggleActive(t)} className="inline-flex px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">
                        {t.status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => openMembers(t)} className="inline-flex px-3 py-2 text-xs font-semibold text-teal-700 bg-teal-50 rounded-md hover:bg-teal-100 transition-colors">
                        Members {t.members && t.members.length > 0 ? `(${t.members.length})` : ''}
                      </button>
                      <button onClick={() => openReset(t.id)} className="inline-flex px-3 py-2 text-xs font-semibold text-purple-700 bg-purple-50 rounded-md hover:bg-purple-100 transition-colors">Reset PIN</button>
                      <button onClick={() => openDelete(t.id)} className="inline-flex px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 rounded-md hover:bg-red-100 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* `m-auto` is what centres these. A native <dialog> centres itself with `margin: auto`, but
          Tailwind's preflight resets every element's margin to 0, which left every dialog pinned to
          the top-left corner of the screen. */}
      <dialog ref={deleteModalRef} className="m-auto rounded-2xl shadow-2xl p-8 max-w-sm backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-3">Delete team?</h3>
        <p className="text-gray-700 text-sm mb-8">This removes their scores and history for this quiz. This cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={() => deleteModalRef.current?.close()}>Cancel</button>
          <button className="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors shadow-md" onClick={handleDelete}>Delete Team</button>
        </div>
      </dialog>

      <dialog ref={resetModalRef} className="m-auto rounded-2xl shadow-2xl p-8 max-w-sm backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-4">Reset team PIN</h3>
        {newPin ? (
          <p className="text-sm text-gray-700 mb-8">New PIN: <b className="font-mono text-lg bg-blue-100 px-3 py-2 rounded text-blue-900 ml-1">{newPin}</b><br/><span className="text-xs text-gray-600 mt-2 block">Share it with the team now — it won&apos;t be shown again.</span></p>
        ) : (
          <p className="text-gray-700 text-sm mb-8">This generates a new PIN and invalidates the old one.</p>
        )}
        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={() => resetModalRef.current?.close()}>
            {newPin ? 'Done' : 'Cancel'}
          </button>
          {!newPin && (
            <button className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors shadow-md" onClick={handleResetPin}>Reset PIN</button>
          )}
        </div>
      </dialog>

      <dialog ref={membersModalRef} className="m-auto rounded-2xl shadow-2xl p-8 w-[min(44rem,92vw)] max-w-none max-h-[88vh] backdrop:bg-black/50">
        <h3 className="text-2xl font-bold text-gray-900 mb-1">
          Team members
          {membersTeam && <span className="ml-2 text-lg font-semibold text-gray-500">— {membersTeam.name}</span>}
        </h3>
        <p className="text-sm text-gray-500 mb-6">
          Name + photo for each member — shown on the Winners screen if this team is declared the winner.
          {membersTeam?.darajah && <span className="block mt-1 text-gray-600">{membersTeam.darajah}</span>}
        </p>

        {membersDraft.length > 0 && (
          <ul className="flex flex-col gap-2 mb-5 max-h-72 overflow-y-auto pr-1">
            {membersDraft.map((m, i) => (
              <li key={i} className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
                <img src={m.photo_url} alt={m.name} className="w-12 h-12 rounded-full object-cover border border-gray-300" />
                <span className="flex-1 text-base font-medium text-gray-900">{m.name}</span>
                <button onClick={() => handleRemoveMember(i)} className="text-red-600 hover:text-red-800 text-xs font-semibold px-2 py-1 rounded hover:bg-red-50">Remove</button>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-6 bg-blue-50 border border-blue-100 rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-800 mb-3">Add a member</p>
          <div className="flex flex-col gap-3">
            <input placeholder="Member name" value={newMemberName} onChange={e => setNewMemberName(e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-base text-gray-900 placeholder-gray-500 bg-white" />
            <div className="flex flex-wrap items-center gap-3">
              <input ref={memberFileRef} type="file" accept="image/*" onChange={e => setNewMemberFile(e.target.files?.[0] || null)}
                className="flex-1 min-w-[16rem] text-sm text-gray-600 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:text-sm file:font-semibold hover:file:bg-blue-700 file:cursor-pointer" />
              <button onClick={handleAddMember} disabled={savingMember || !newMemberName.trim() || !newMemberFile}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow-sm transition-colors shrink-0">
                {savingMember ? 'Adding…' : '+ Add Member'}
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-lg border-2 border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors" onClick={() => membersModalRef.current?.close()}>Cancel</button>
          <button onClick={handleSaveMembers} disabled={savingMembers}
            className="px-6 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-semibold transition-colors shadow-md">
            {savingMembers ? 'Saving…' : 'Save Members'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
