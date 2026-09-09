-- Enables Postgres Realtime broadcasting for the tables the live pages subscribe to.
-- Without this, RLS lets you READ these tables fine, but changes never get PUSHED to
-- subscribers (host/team/display pages) — every action requires a manual page reload to
-- see, because the initial page-load fetch is the only time the data is ever read.
-- Safe to run more than once: skips any table already in the publication.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'live_sessions', 'buzzer_events', 'scores', 'question_set_items', 'answers', 'eliminations'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
