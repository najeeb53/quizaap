-- Migration 011 — realtime delete events, schema drift, and referential integrity.
--
-- Run this whole file once in the Supabase SQL editor. Every statement is written to be
-- safe to re-run.

-- ---------------------------------------------------------------------------------------
-- 1. REPLICA IDENTITY FULL — makes DELETE events actually reach the screens.
--
-- With Postgres' default replica identity, a DELETE's WAL record carries ONLY the primary
-- key. Supabase Realtime matches subscription filters (e.g. `session_id=eq.<id>`) against
-- that record — and since session_id isn't in it, the event never matches and is never
-- delivered. Every "reset" in this app is a DELETE, so the Host/Team/Display screens were
-- never told about them: the database was correct while the screens kept showing stale
-- buzzes, answers and scores until something else happened to trigger a refresh.
--
-- These tables are small, so carrying the full old row costs nothing.
ALTER TABLE public.buzzer_events      REPLICA IDENTITY FULL;
ALTER TABLE public.answers            REPLICA IDENTITY FULL;
ALTER TABLE public.scores             REPLICA IDENTITY FULL;
ALTER TABLE public.question_set_items REPLICA IDENTITY FULL;
ALTER TABLE public.live_sessions      REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------------------
-- 2. Schema drift: rounds.category_ids is written and read by the app but was never in a
--    migration. On a rebuilt database every round insert would fail with "column does not
--    exist" — and the admin page swallows that error, so rounds would silently not save.
ALTER TABLE public.rounds ADD COLUMN IF NOT EXISTS category_ids UUID[];

-- ---------------------------------------------------------------------------------------
-- 3. Foreign keys that block deletes. These all defaulted to NO ACTION, so deleting a
--    round/team that had been played was refused by Postgres — and the admin UI discarded
--    the error, so the row just silently stayed put no matter how many times you clicked
--    Delete. Pointers now null themselves out; a deleted round takes its scores with it.
ALTER TABLE public.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_current_round_id_fkey;
ALTER TABLE public.live_sessions ADD CONSTRAINT live_sessions_current_round_id_fkey
  FOREIGN KEY (current_round_id) REFERENCES public.rounds(id) ON DELETE SET NULL;

ALTER TABLE public.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_current_question_set_item_id_fkey;
ALTER TABLE public.live_sessions ADD CONSTRAINT live_sessions_current_question_set_item_id_fkey
  FOREIGN KEY (current_question_set_item_id) REFERENCES public.question_set_items(id) ON DELETE SET NULL;

ALTER TABLE public.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_current_picker_team_id_fkey;
ALTER TABLE public.live_sessions ADD CONSTRAINT live_sessions_current_picker_team_id_fkey
  FOREIGN KEY (current_picker_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE public.question_set_items DROP CONSTRAINT IF EXISTS question_set_items_picked_by_team_id_fkey;
ALTER TABLE public.question_set_items ADD CONSTRAINT question_set_items_picked_by_team_id_fkey
  FOREIGN KEY (picked_by_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE public.scores DROP CONSTRAINT IF EXISTS scores_round_id_fkey;
ALTER TABLE public.scores ADD CONSTRAINT scores_round_id_fkey
  FOREIGN KEY (round_id) REFERENCES public.rounds(id) ON DELETE CASCADE;

ALTER TABLE public.eliminations DROP CONSTRAINT IF EXISTS eliminations_round_id_fkey;
ALTER TABLE public.eliminations ADD CONSTRAINT eliminations_round_id_fkey
  FOREIGN KEY (round_id) REFERENCES public.rounds(id) ON DELETE CASCADE;

-- Deleting a question that is already inside a generated question set used to CASCADE —
-- silently removing that question from a locked set (and its answers/buzzes with it), so a
-- round would quietly play one question short. Refuse the delete instead; the app now
-- checks first and tells you which sets are using it.
ALTER TABLE public.question_set_items DROP CONSTRAINT IF EXISTS question_set_items_question_id_fkey;
ALTER TABLE public.question_set_items ADD CONSTRAINT question_set_items_question_id_fkey
  FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE RESTRICT;

-- scores.question_set_item_id is now populated (for per-question reset + idempotent
-- scoring), so it needs a delete rule that doesn't block unlocking a round.
ALTER TABLE public.scores DROP CONSTRAINT IF EXISTS scores_question_set_item_id_fkey;
ALTER TABLE public.scores ADD CONSTRAINT scores_question_set_item_id_fkey
  FOREIGN KEY (question_set_item_id) REFERENCES public.question_set_items(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------
-- 4. One question set per (session, round). Without this, an Unlock immediately followed by
--    a Lock (or two admin tabs) could create two sets — after which the round loads with
--    .maybeSingle(), gets a "multiple rows" error, and plays ZERO questions with no message.
DELETE FROM public.question_sets a USING public.question_sets b
  WHERE a.session_id = b.session_id AND a.round_id = b.round_id AND a.ctid < b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS question_sets_session_round_uniq
  ON public.question_sets (session_id, round_id);

-- ---------------------------------------------------------------------------------------
-- 5. The remaining missing DELETE policies. Nothing deletes from these tables today, but
--    this is the exact gap that made every reset silently do nothing before migration_010
--    — a delete with no policy removes zero rows and reports no error.
DROP POLICY IF EXISTS "live_sessions: allow anon delete" ON public.live_sessions;
CREATE POLICY "live_sessions: allow anon delete" ON public.live_sessions FOR DELETE USING (true);

DROP POLICY IF EXISTS "eliminations: allow anon delete" ON public.eliminations;
CREATE POLICY "eliminations: allow anon delete" ON public.eliminations FOR DELETE USING (true);

-- ---------------------------------------------------------------------------------------
-- 6. Indexes for the queries that run on every realtime event during a show.
CREATE INDEX IF NOT EXISTS scores_session_round_idx  ON public.scores (session_id, round_id);
CREATE INDEX IF NOT EXISTS scores_session_item_idx   ON public.scores (session_id, question_set_item_id);
CREATE INDEX IF NOT EXISTS qsi_set_order_idx         ON public.question_set_items (question_set_id, display_order);
CREATE INDEX IF NOT EXISTS questions_pool_idx        ON public.questions (status, type, difficulty, category_id);

-- ---------------------------------------------------------------------------------------
-- 7. Buzzer ordering. Rank is now taken from the server clock everywhere instead of a
--    client-computed counter (which two teams buzzing at once could both read as "1").
--    clock_timestamp() is the real instant; now() is transaction-start time, so several
--    buzzes inside the same transaction window could tie.
ALTER TABLE public.buzzer_events
  ALTER COLUMN buzzed_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'utc');

-- ---------------------------------------------------------------------------------------
-- NOTE — migration_002_quiz_engine.sql cannot be re-run as written: it uses
-- `CREATE POLICY IF NOT EXISTS`, which is not valid PostgreSQL (unlike CREATE TABLE,
-- CREATE POLICY has no IF NOT EXISTS clause). Those 8 statements would abort the whole
-- script on a fresh database, leaving those tables with RLS on and NO policies — i.e. every
-- query returning empty with no error. The live database already has the policies (they
-- were applied by hand), so nothing is broken today, but rebuilding from this folder would
-- fail. migration_012 rewrites them in the DROP-then-CREATE form used everywhere else.
