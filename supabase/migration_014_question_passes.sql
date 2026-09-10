-- Tracks which teams have passed on a given question (MCQ rounds only, host-controlled).
-- Passing never scores anything by itself — it's just a record of "this team declined this
-- question" so the host UI can move on to the next team and so gradeAndReveal can tell that this
-- question changed hands (which is what triggers the reduced fixed +5 award for whoever finally
-- answers it correctly, instead of the round's normal marks_correct).
CREATE TABLE IF NOT EXISTS question_passes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_set_item_id UUID REFERENCES question_set_items(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  passed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  UNIQUE (session_id, question_set_item_id, team_id)
);

ALTER TABLE question_passes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_passes: allow anon read" ON question_passes;
CREATE POLICY "question_passes: allow anon read" ON question_passes FOR SELECT USING (true);
DROP POLICY IF EXISTS "question_passes: allow anon insert" ON question_passes;
CREATE POLICY "question_passes: allow anon insert" ON question_passes FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "question_passes: allow anon delete" ON question_passes;
CREATE POLICY "question_passes: allow anon delete" ON question_passes FOR DELETE USING (true);

-- Realtime, same idempotent pattern as migration_007 — safe to run more than once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'question_passes'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.question_passes';
  END IF;
END $$;
