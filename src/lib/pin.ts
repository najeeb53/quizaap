// Lightweight client-side PIN hashing.
// NOTE: this app currently has no authenticated backend (anon Supabase key only),
// so this cannot be a substitute for real server-side auth. It only prevents the
// PIN from being stored or displayed in plain text in the database, and lets the
// team join screen verify a PIN without ever reading other teams' PINs back.
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomCode(length = 5): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function randomPin(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}
