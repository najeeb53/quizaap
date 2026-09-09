-- =============================================================
-- Migration 002: Quiz / Round / Team / Live-session engine (MVP)
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor)
-- Safe to run once. Adds columns/tables needed for:
--   - Quiz management
--   - Round builder
--   - Category/question selection + locking (question sets)
--   - Team management
--   - Live session engine (current question, timer, buzzer, scoring, elimination)
-- =============================================================

-- ---- quizzes: add fields used by the quiz builder ----
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS number_of_teams INTEGER;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;
-- status already exists (draft/...). Add a check for known MVP states (optional, non-breaking if skipped)

-- ---- rounds: add fields used by the round builder ----
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS marks_correct INTEGER DEFAULT 10;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS marks_wrong INTEGER DEFAULT 0;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS marks_skip INTEGER DEFAULT 0;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS timer_seconds INTEGER DEFAULT 30;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS buzzer_enabled BOOLEAN DEFAULT false;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS elimination_enabled BOOLEAN DEFAULT false;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS elimination_count INTEGER DEFAULT 0;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS category_selection TEXT DEFAULT 'random'; -- 'random' | 'manual'

-- ---- question_sets: frozen question selection per round per live session ----
CREATE TABLE IF NOT EXISTS question_sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  round_id UUID REFERENCES rounds(id) ON DELETE CASCADE,
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  locked_at TIMESTAMP WITH TIME ZONE,
  generation_seed TEXT
);

CREATE TABLE IF NOT EXISTS question_set_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_set_id UUID REFERENCES question_sets(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id),
  display_order INTEGER NOT NULL,
  option_order JSONB DEFAULT '[]' -- frozen shuffled option_key order, e.g. ["C","A","D","B"]
);

-- ---- eliminations ----
CREATE TABLE IF NOT EXISTS eliminations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  round_id UUID REFERENCES rounds(id),
  reason TEXT,
  eliminated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  reversed_at TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES users(id)
);

-- ---- live_events: append-only audit/event stream ----
CREATE TABLE IF NOT EXISTS live_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ---- live_sessions: point at the frozen question set / current item ----
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS current_question_set_item_id UUID REFERENCES question_set_items(id);

-- =============================================================
-- RLS for new tables (dev-permissive, matches existing policy style)
-- =============================================================
ALTER TABLE question_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "question_sets: allow anon read"   ON question_sets FOR SELECT USING (true);
DROP POLICY IF EXISTS "question_sets: allow anon insert" ON question_sets;
CREATE POLICY "question_sets: allow anon insert" ON question_sets FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "question_sets: allow anon update" ON question_sets;
CREATE POLICY "question_sets: allow anon update" ON question_sets FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "question_sets: allow anon delete" ON question_sets;
CREATE POLICY "question_sets: allow anon delete" ON question_sets FOR DELETE USING (true);

ALTER TABLE question_set_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "question_set_items: allow anon read"   ON question_set_items FOR SELECT USING (true);
DROP POLICY IF EXISTS "question_set_items: allow anon insert" ON question_set_items;
CREATE POLICY "question_set_items: allow anon insert" ON question_set_items FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "question_set_items: allow anon update" ON question_set_items;
CREATE POLICY "question_set_items: allow anon update" ON question_set_items FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "question_set_items: allow anon delete" ON question_set_items;
CREATE POLICY "question_set_items: allow anon delete" ON question_set_items FOR DELETE USING (true);

ALTER TABLE eliminations ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "eliminations: allow anon read"   ON eliminations FOR SELECT USING (true);
DROP POLICY IF EXISTS "eliminations: allow anon insert" ON eliminations;
CREATE POLICY "eliminations: allow anon insert" ON eliminations FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "eliminations: allow anon update" ON eliminations;
CREATE POLICY "eliminations: allow anon update" ON eliminations FOR UPDATE USING (true) WITH CHECK (true);

ALTER TABLE live_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "live_events: allow anon read"   ON live_events FOR SELECT USING (true);
DROP POLICY IF EXISTS "live_events: allow anon insert" ON live_events;
CREATE POLICY "live_events: allow anon insert" ON live_events FOR INSERT WITH CHECK (true);

ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "quizzes: allow anon read"   ON quizzes FOR SELECT USING (true);
DROP POLICY IF EXISTS "quizzes: allow anon insert" ON quizzes;
CREATE POLICY "quizzes: allow anon insert" ON quizzes FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "quizzes: allow anon update" ON quizzes;
CREATE POLICY "quizzes: allow anon update" ON quizzes FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "quizzes: allow anon delete" ON quizzes;
CREATE POLICY "quizzes: allow anon delete" ON quizzes FOR DELETE USING (true);

ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "rounds: allow anon read"   ON rounds FOR SELECT USING (true);
DROP POLICY IF EXISTS "rounds: allow anon insert" ON rounds;
CREATE POLICY "rounds: allow anon insert" ON rounds FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "rounds: allow anon update" ON rounds;
CREATE POLICY "rounds: allow anon update" ON rounds FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "rounds: allow anon delete" ON rounds;
CREATE POLICY "rounds: allow anon delete" ON rounds FOR DELETE USING (true);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "teams: allow anon insert" ON teams;
CREATE POLICY "teams: allow anon insert" ON teams FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "teams: allow anon update" ON teams;
CREATE POLICY "teams: allow anon update" ON teams FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "teams: allow anon delete" ON teams;
CREATE POLICY "teams: allow anon delete" ON teams FOR DELETE USING (true);

ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "live_sessions: allow anon insert" ON live_sessions;
CREATE POLICY "live_sessions: allow anon insert" ON live_sessions FOR INSERT WITH CHECK (true);

ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "answers: allow anon read"   ON answers FOR SELECT USING (true);
DROP POLICY IF EXISTS "answers: allow anon insert" ON answers;
CREATE POLICY "answers: allow anon insert" ON answers FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "answers: allow anon update" ON answers;
CREATE POLICY "answers: allow anon update" ON answers FOR UPDATE USING (true) WITH CHECK (true);

ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "scores: allow anon read"   ON scores FOR SELECT USING (true);
DROP POLICY IF EXISTS "scores: allow anon insert" ON scores;
CREATE POLICY "scores: allow anon insert" ON scores FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "scores: allow anon update" ON scores;
CREATE POLICY "scores: allow anon update" ON scores FOR UPDATE USING (true) WITH CHECK (true);

ALTER TABLE buzzer_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buzzer_events: allow anon update" ON buzzer_events;
CREATE POLICY "buzzer_events: allow anon update" ON buzzer_events FOR UPDATE USING (true) WITH CHECK (true);
