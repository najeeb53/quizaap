-- Team members (name + photo) for the Winners screen, and which team a session has declared as
-- its winner. `members` is a simple JSONB array of {name, photo_url} — no separate table, since
-- members are only ever read/written as a whole list per team (add/remove/reorder from the admin
-- Teams page), never queried individually.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS members JSONB DEFAULT '[]';
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS winner_team_id UUID REFERENCES teams(id);

-- Storage bucket for team member photos — same public-read/permissive-write posture as
-- question-images (migration_009); this app has no auth yet.
INSERT INTO storage.buckets (id, name, public)
VALUES ('team-photos', 'team-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "team-photos: public read" ON storage.objects;
CREATE POLICY "team-photos: public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'team-photos');

DROP POLICY IF EXISTS "team-photos: anon insert" ON storage.objects;
CREATE POLICY "team-photos: anon insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'team-photos');

DROP POLICY IF EXISTS "team-photos: anon update" ON storage.objects;
CREATE POLICY "team-photos: anon update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'team-photos') WITH CHECK (bucket_id = 'team-photos');

DROP POLICY IF EXISTS "team-photos: anon delete" ON storage.objects;
CREATE POLICY "team-photos: anon delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'team-photos');
