-- Root-cause fix: buzzer_events, answers, and scores were given RLS-enabled SELECT/INSERT/UPDATE
-- policies but were NEVER given a DELETE policy in any earlier migration. Supabase/Postgres RLS
-- doesn't error on a delete that matches no visible rows — it just silently deletes nothing — so
-- every "Reset Buzzer", "Reset Round", "Reset Scores", "Reset Question", and the auto-clear on
-- Open Buzzer have been no-ops against these three tables this whole time, which is why stale
-- buzzer results (and old scores/answers) kept reappearing no matter what was reset.

DROP POLICY IF EXISTS "buzzer_events: allow anon delete" ON buzzer_events;
CREATE POLICY "buzzer_events: allow anon delete" ON buzzer_events FOR DELETE USING (true);

DROP POLICY IF EXISTS "answers: allow anon delete" ON answers;
CREATE POLICY "answers: allow anon delete" ON answers FOR DELETE USING (true);

DROP POLICY IF EXISTS "scores: allow anon delete" ON scores;
CREATE POLICY "scores: allow anon delete" ON scores FOR DELETE USING (true);
