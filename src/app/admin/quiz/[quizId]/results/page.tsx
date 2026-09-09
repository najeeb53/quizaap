'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { fetchScoreboard, type ScoreRow } from '@/lib/scoreboard';
import { restoreTeam } from '@/lib/liveEngine';

type LiveEvent = { id: string; event_type: string; payload_json: any; created_at: string };
type Elimination = { id: string; team_id: string; reason: string | null; eliminated_at: string; reversed_at: string | null; team_name?: string };

export default function ResultsPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [eliminations, setEliminations] = useState<Elimination[]>([]);
  const [filterAction, setFilterAction] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: sess } = await supabase.from('live_sessions').select('id').eq('quiz_id', quizId).order('started_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    const sid = sess?.id || null;
    setSessionId(sid);
    if (!sid) { setLoading(false); return; }

    const [sb, { data: ev }, { data: elim }] = await Promise.all([
      fetchScoreboard(quizId, sid),
      supabase.from('live_events').select('*').eq('session_id', sid).order('created_at', { ascending: false }),
      supabase.from('eliminations').select('id, team_id, reason, eliminated_at, reversed_at, teams(name)').eq('session_id', sid).order('eliminated_at', { ascending: false }),
    ]);
    setScoreboard(sb);
    setEvents(ev || []);
    setEliminations((elim || []).map((e: any) => ({ ...e, team_name: e.teams?.name })));
    setLoading(false);
  }, [quizId]);

  useEffect(() => { load(); }, [load]);

  function exportCsv() {
    const rows = [['Rank', 'Team', 'Total Points'], ...scoreboard.map(t => [String(t.rank), t.name, String(t.total)])];
    const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'quiz-results.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const filteredEvents = filterAction === 'all' ? events : events.filter(e => e.event_type === filterAction);
  const actionTypes = Array.from(new Set(events.map(e => e.event_type)));

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <p className="text-gray-500 text-sm font-medium">Loading…</p>
    </div>
  );
  if (!sessionId) return (
    <div className="flex items-center justify-center py-24">
      <p className="text-gray-500 text-sm font-medium">No live session has been run for this quiz yet.</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">🏆 Results</h1>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-900 to-gray-800 flex justify-between items-center">
          <h3 className="text-lg font-bold text-white">Final Scoreboard</h3>
          <button onClick={exportCsv} className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow hover:shadow-lg transition-all">Export CSV</button>
        </div>
        <ol className="divide-y divide-gray-100">
          {scoreboard.map(t => {
            const rankStyle =
              t.rank === 1 ? 'bg-amber-50' :
              t.rank === 2 ? 'bg-gray-50' :
              t.rank === 3 ? 'bg-orange-50' : 'bg-white';
            const badgeStyle =
              t.rank === 1 ? 'bg-amber-100 text-amber-800' :
              t.rank === 2 ? 'bg-gray-200 text-gray-700' :
              t.rank === 3 ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600';
            return (
              <li key={t.team_id} className={`px-6 py-4 flex justify-between items-center text-sm hover:bg-blue-50 transition-colors ${t.eliminated ? 'text-gray-400' : 'text-gray-900'} ${!t.eliminated ? rankStyle : ''}`}>
                <span className="flex items-center gap-3">
                  <span className={`inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-full text-xs font-bold ${t.eliminated ? 'bg-gray-100 text-gray-400' : badgeStyle}`}>
                    {t.rank === 1 && !t.eliminated ? '🏆' : `#${t.rank}`}
                  </span>
                  <span className="font-medium">{t.name}{t.eliminated ? ' (eliminated)' : ''}</span>
                </span>
                <span className="font-bold text-gray-900">{t.total} pts</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-900 to-gray-800">
          <h3 className="text-lg font-bold text-white">Eliminations</h3>
        </div>
        {eliminations.length === 0 ? <p className="p-6 text-gray-500 text-sm">No eliminations.</p> : (
          <ul className="divide-y divide-gray-100">
            {eliminations.map((e, i) => (
              <li key={e.id} className={`px-6 py-4 flex justify-between items-center text-sm hover:bg-blue-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                <span className="text-gray-700">{e.team_name} — {e.reason} {e.reversed_at && <em className="text-gray-400">(restored)</em>}</span>
                {!e.reversed_at && (
                  <button onClick={() => restoreTeam(e.id, e.team_id).then(load)} className="text-blue-600 hover:text-blue-800 font-semibold hover:underline transition-colors">Restore</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-900 to-gray-800 flex justify-between items-center">
          <h3 className="text-lg font-bold text-white">Audit Log</h3>
          <select value={filterAction} onChange={e => setFilterAction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none">
            <option value="all">All actions</option>
            {actionTypes.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        {filteredEvents.length === 0 ? <p className="p-6 text-gray-500 text-sm">No events recorded.</p> : (
          <div className="max-h-96 overflow-y-auto">
            <ul className="divide-y divide-gray-100 text-sm">
              {filteredEvents.map((e, i) => (
                <li key={e.id} className={`px-6 py-3 flex justify-between gap-4 hover:bg-blue-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                  <span className="font-mono text-xs text-gray-500">{new Date(e.created_at).toLocaleTimeString()}</span>
                  <span className="flex-1 text-gray-700 font-medium">{e.event_type}</span>
                  <span className="text-gray-400 text-xs truncate max-w-xs">{JSON.stringify(e.payload_json)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
