-- =============================================================
-- Migration 004: merge duplicate categories
-- The CSV importer / Add-Question form used to match category names with an
-- exact (case- and whitespace-sensitive) comparison, so rows like
-- "Architecture/Engineering" vs " architecture/engineering " each created a
-- brand-new category. This merges every group of categories that share the
-- same trimmed, lower-cased name into a single row, moves all their
-- questions onto the survivor, and deletes the duplicates.
-- Safe to run multiple times. Run in Supabase SQL Editor.
-- =============================================================

DO $$
DECLARE
  grp RECORD;
  keeper UUID;
BEGIN
  FOR grp IN
    SELECT lower(trim(name)) AS norm_name, array_agg(id ORDER BY created_at NULLS LAST, id) AS ids
    FROM categories
    GROUP BY lower(trim(name))
    HAVING count(*) > 1
  LOOP
    keeper := grp.ids[1];

    -- repoint questions from every duplicate onto the keeper
    UPDATE questions
    SET category_id = keeper
    WHERE category_id = ANY(grp.ids[2:array_length(grp.ids, 1)]);

    -- repoint any already-locked question_set_items too (keeps historical sets valid)
    UPDATE question_set_items
    SET category_id = keeper
    WHERE category_id = ANY(grp.ids[2:array_length(grp.ids, 1)]);

    -- tidy the surviving row's name (trimmed) and drop the duplicates
    UPDATE categories SET name = trim(name) WHERE id = keeper;
    DELETE FROM categories WHERE id = ANY(grp.ids[2:array_length(grp.ids, 1)]);
  END LOOP;
END $$;
