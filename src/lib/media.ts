// A Picture question can carry multiple images (questions.media_urls TEXT[]). Older rows only
// ever had the single media_url column, and migration_013 backfills media_urls from it — but any
// row read before that backfill runs, or written by code that hasn't been updated yet, might still
// only have media_url set. Centralizing the fallback here means every screen (team/host/display)
// shows the same picture(s) for the same question, instead of each page re-deriving it slightly
// differently.
export function questionImages(q: { media_url?: string | null; media_urls?: string[] | null } | null | undefined): string[] {
  if (!q) return [];
  if (q.media_urls && q.media_urls.length > 0) return q.media_urls;
  return q.media_url ? [q.media_url] : [];
}
