import { supabase } from './supabaseClient';

export type ScoreRow = { team_id: string; name: string; total: number; eliminated: boolean; rank: number };

/** Fetches every scores row for a session, paging past Supabase/PostgREST's default 1000-row
 * cap — a session that has accumulated more than 1000 score entries (heavy testing, a long
 * tournament) would otherwise have its totals silently computed from only a partial, arbitrary
 * slice of its history. */
async function fetchAllScores(sessionId: string): Promise<{ team_id: string; points: number }[]> {
  const pageSize = 1000;
  const all: { team_id: string; points: number }[] = [];
  for (let from = 0; ; from += pageSize) {
    // .order('id') keeps paging stable while the show is writing new score rows underneath us.
    // A failed page throws rather than breaking: treating an error as "end of data" would quietly
    // present a partial total as the final scoreboard — the exact failure this function exists
    // to prevent.
    const { data, error } = await supabase.from('scores').select('team_id, points')
      .eq('session_id', sessionId).order('id').range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

export async function fetchScoreboard(quizId: string, sessionId: string): Promise<ScoreRow[]> {
  const [{ data: teams }, scores] = await Promise.all([
    supabase.from('teams').select('id, name, eliminated_at').eq('quiz_id', quizId),
    fetchAllScores(sessionId),
  ]);
  const totals: Record<string, number> = {};
  for (const s of scores) totals[s.team_id] = (totals[s.team_id] || 0) + s.points;

  const rows = (teams || []).map(t => ({
    team_id: t.id, name: t.name, total: totals[t.id] || 0, eliminated: !!t.eliminated_at, rank: 0,
  }));
  // Tied teams share a rank. Previously three teams on 40 points rendered as #1/#2/#3 in
  // whatever order the teams table happened to return — so the projector declared a leader
  // among tied teams, and could name a different one after a refresh.
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].total === r.total ? rows[i - 1].rank : i + 1; });
  return rows;
}
