-- Team-picks-category rounds now generate "blank" slots (difficulty only, no category or
-- question yet) — the category and question are assigned only when a team picks, at play time.
-- Allow those two columns to be null to support that.

ALTER TABLE question_set_items ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE question_set_items ALTER COLUMN question_id DROP NOT NULL;
