-- =============================================================
-- RLS Policies for Live Quiz App
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor)
-- =============================================================

-- categories
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "categories: allow anon read"   ON categories FOR SELECT USING (true);
CREATE POLICY "categories: allow anon insert" ON categories FOR INSERT WITH CHECK (true);
CREATE POLICY "categories: allow anon update" ON categories FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "categories: allow anon delete" ON categories FOR DELETE USING (true);

-- questions
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "questions: allow anon read"   ON questions FOR SELECT USING (true);
CREATE POLICY "questions: allow anon insert" ON questions FOR INSERT WITH CHECK (true);
CREATE POLICY "questions: allow anon update" ON questions FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "questions: allow anon delete" ON questions FOR DELETE USING (true);

-- question_options
ALTER TABLE question_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "question_options: allow anon read"   ON question_options FOR SELECT USING (true);
CREATE POLICY "question_options: allow anon insert" ON question_options FOR INSERT WITH CHECK (true);
CREATE POLICY "question_options: allow anon update" ON question_options FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "question_options: allow anon delete" ON question_options FOR DELETE USING (true);

-- teams (team page looks up by code)
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams: allow anon read" ON teams FOR SELECT USING (true);

-- live_sessions (host updates state; team and display subscribe)
ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_sessions: allow anon read"   ON live_sessions FOR SELECT USING (true);
CREATE POLICY "live_sessions: allow anon update" ON live_sessions FOR UPDATE USING (true) WITH CHECK (true);

-- buzzer_events (teams insert; host reads)
ALTER TABLE buzzer_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "buzzer_events: allow anon read"   ON buzzer_events FOR SELECT USING (true);
CREATE POLICY "buzzer_events: allow anon insert" ON buzzer_events FOR INSERT WITH CHECK (true);
