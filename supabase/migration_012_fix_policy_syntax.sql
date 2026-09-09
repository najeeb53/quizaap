-- Migration 012 — make the SELECT policies from migration_002 reproducible.
--
-- migration_002_quiz_engine.sql declares eight policies with `CREATE POLICY IF NOT EXISTS`.
-- PostgreSQL has no IF NOT EXISTS clause for CREATE POLICY (only CREATE TABLE and friends
-- have one), so each of those is a syntax error. The Supabase SQL editor runs a script as a
-- single transaction, so on a fresh database migration_002 aborts at the first one and rolls
-- back — leaving those tables with RLS ENABLED and no policies at all, which makes every
-- read return an empty array with no error anywhere.
--
-- The live database already has these policies (they were applied by hand while building),
-- so this changes nothing there. It exists so `supabase/` can actually rebuild the database.
-- Running it is harmless and idempotent.

DROP POLICY IF EXISTS "question_sets: allow anon read" ON question_sets;
CREATE POLICY "question_sets: allow anon read" ON question_sets FOR SELECT USING (true);

DROP POLICY IF EXISTS "question_set_items: allow anon read" ON question_set_items;
CREATE POLICY "question_set_items: allow anon read" ON question_set_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "eliminations: allow anon read" ON eliminations;
CREATE POLICY "eliminations: allow anon read" ON eliminations FOR SELECT USING (true);

DROP POLICY IF EXISTS "live_events: allow anon read" ON live_events;
CREATE POLICY "live_events: allow anon read" ON live_events FOR SELECT USING (true);

DROP POLICY IF EXISTS "quizzes: allow anon read" ON quizzes;
CREATE POLICY "quizzes: allow anon read" ON quizzes FOR SELECT USING (true);

DROP POLICY IF EXISTS "rounds: allow anon read" ON rounds;
CREATE POLICY "rounds: allow anon read" ON rounds FOR SELECT USING (true);

DROP POLICY IF EXISTS "answers: allow anon read" ON answers;
CREATE POLICY "answers: allow anon read" ON answers FOR SELECT USING (true);

DROP POLICY IF EXISTS "scores: allow anon read" ON scores;
CREATE POLICY "scores: allow anon read" ON scores FOR SELECT USING (true);

-- Two tables were created without RLS ever being enabled, so anon can read and write them
-- freely. `users` holds admin rows; `round_questions` is dead (superseded by
-- question_set_items) but still has foreign keys from live_sessions, answers, and buzzer_events.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;  -- no policies = anon sees nothing

-- Drop the foreign key constraints before dropping the table
ALTER TABLE public.live_sessions
  DROP CONSTRAINT IF EXISTS live_sessions_current_round_question_id_fkey;
ALTER TABLE public.answers
  DROP CONSTRAINT IF EXISTS answers_round_question_id_fkey;
ALTER TABLE public.buzzer_events
  DROP CONSTRAINT IF EXISTS buzzer_events_round_question_id_fkey;

-- Now drop the table safely
DROP TABLE IF EXISTS public.round_questions;
