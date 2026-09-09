-- Storage bucket for Picture-round question images. Public read (so host/team/display can all
-- show the image directly by URL) with permissive write, matching this app's dev-mode RLS
-- posture elsewhere (no auth yet).

INSERT INTO storage.buckets (id, name, public)
VALUES ('question-images', 'question-images', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "question-images: public read" ON storage.objects;
CREATE POLICY "question-images: public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'question-images');

DROP POLICY IF EXISTS "question-images: anon insert" ON storage.objects;
CREATE POLICY "question-images: anon insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'question-images');

DROP POLICY IF EXISTS "question-images: anon update" ON storage.objects;
CREATE POLICY "question-images: anon update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'question-images') WITH CHECK (bucket_id = 'question-images');

DROP POLICY IF EXISTS "question-images: anon delete" ON storage.objects;
CREATE POLICY "question-images: anon delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'question-images');
