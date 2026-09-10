import { supabase } from './supabaseClient';

const BUCKET = 'team-photos';
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Uploads a team member's photo to Supabase Storage and returns its public URL, or null on
 * failure. Same validation as the question-bank's image upload (extension from MIME type, not
 * filename; 5MB cap) — see admin/question-bank/page.tsx for why. */
export async function uploadTeamPhoto(file: File): Promise<string | null> {
  const ext = MIME_EXT[file.type];
  if (!ext) { alert('Please choose a JPEG, PNG, WebP or GIF image.'); return null; }
  if (file.size > MAX_IMAGE_BYTES) { alert(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — please use one under 5 MB.`); return null; }
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (error) { console.error(error); return null; }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
