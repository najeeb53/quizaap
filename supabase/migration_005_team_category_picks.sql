-- =============================================================
-- Migration 005: teams choose their own category (turn-based)
-- Adds an opt-in per-round mode where, instead of the host auto-advancing
-- through the frozen question set, the team whose turn it is picks a
-- category (the difficulty tier is still fixed in advance by the admin via
-- the existing Generate Question Set counts — teams only choose which
-- category within the current tier).
-- Run in Supabase SQL Editor after migrations 002-004.
-- =============================================================

ALTER TABLE rounds ADD COLUMN IF NOT EXISTS team_picks_category BOOLEAN DEFAULT false;

-- denormalized so the pick UI doesn't need to join back to questions for every tile
ALTER TABLE question_set_items ADD COLUMN IF NOT EXISTS difficulty TEXT;
ALTER TABLE question_set_items ADD COLUMN IF NOT EXISTS picked_by_team_id UUID REFERENCES teams(id);
ALTER TABLE question_set_items ADD COLUMN IF NOT EXISTS picked_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS current_picker_team_id UUID REFERENCES teams(id);
