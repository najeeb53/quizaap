-- Picture questions previously stored exactly one image (questions.media_url TEXT). The
-- question bank now supports uploading several images per question, so we need a place to put
-- more than one URL. `media_url` is kept as-is (nothing reads it destructively, and older rows
-- still have it) — `media_urls` is the new source of truth going forward for how many images a
-- question has and in what order.

ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS media_urls TEXT[] DEFAULT '{}';

-- Backfill: any existing Picture question with a single media_url but no media_urls yet gets it
-- copied over as a one-element array, so old questions keep showing their image after this
-- migration instead of suddenly appearing blank.
UPDATE public.questions
SET media_urls = ARRAY[media_url]
WHERE media_url IS NOT NULL
  AND (media_urls IS NULL OR array_length(media_urls, 1) IS NULL);
