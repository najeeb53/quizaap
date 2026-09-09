-- =============================================================
-- Migration 003: link answers/buzzer_events/scores to the frozen
-- per-session question_set_items (instead of the unused round_questions
-- table), and add basic duplicate-submission protection.
-- Run in Supabase SQL Editor after migration_002_quiz_engine.sql.
-- =============================================================

ALTER TABLE answers ADD COLUMN IF NOT EXISTS question_set_item_id UUID REFERENCES question_set_items(id) ON DELETE CASCADE;
ALTER TABLE buzzer_events ADD COLUMN IF NOT EXISTS question_set_item_id UUID REFERENCES question_set_items(id) ON DELETE CASCADE;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS question_set_item_id UUID REFERENCES question_set_items(id);

-- Prevent a team submitting more than one answer to the same question in a session
DO $$ BEGIN
  ALTER TABLE answers ADD CONSTRAINT answers_unique_submission UNIQUE (session_id, question_set_item_id, team_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Prevent a team buzzing more than once for the same question in a session
DO $$ BEGIN
  ALTER TABLE buzzer_events ADD CONSTRAINT buzzer_events_unique_buzz UNIQUE (session_id, question_set_item_id, team_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- live_sessions: track which round is "live" right now plus simple round-stage
-- (idle -> round_intro -> question -> buzzer_open -> answer_reveal -> scoreboard)
-- display_state already covers this; nothing further needed here.
