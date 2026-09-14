-- Sudden-death tie-break. When two teams are level on points at an elimination, the host runs one
-- extra question for those teams only, on the projector, and the result decides who goes.
--
-- Held on the session rather than in its own table: a tie-break is transient state about what is
-- on screen right now (exactly like current_question_set_item_id), not a record to keep. What
-- actually happened is already durable — the `eliminations` row it produces, and the
-- tiebreak_started / tiebreak_resolved events in the audit log.
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS tiebreak JSONB;
