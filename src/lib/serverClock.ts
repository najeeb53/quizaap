import { supabase } from './supabaseClient';

/**
 * One clock for the whole show.
 *
 * Every timestamp the database writes for itself — `answers.submitted_at`, `buzzer_events.buzzed_at`,
 * `live_events.created_at` — is stamped by Postgres. But `timer_state.startedAt` was written with
 * `new Date().toISOString()` on whichever machine happened to start the timer (the host's PC).
 * Those are two different clocks, and a live quiz then computed times by subtracting one from the
 * other:
 *
 *     elapsed = answers.submitted_at (database clock) - timer_state.startedAt (host's PC clock)
 *
 * A host PC running even a few seconds fast made every Sequencing "completed in Ns" figure come out
 * negative — clamped to 0.0s by the callers, so every team tied at zero and the ranking the round
 * exists to produce silently collapsed. A PC running slow inflated every time by the same offset.
 * Nothing looked broken; the numbers were just wrong.
 *
 * So: measure this browser's offset from the database clock once, and put every timestamp on the
 * database's clock. The measurement is NTP-style — write a row, read back the timestamp Postgres
 * gave it, and assume it was stamped about halfway through the round trip:
 *
 *     offset = dbTime - (sentAt + roundTrip / 2)
 *
 * Accurate to roughly half a round trip (tens of milliseconds), against a PC clock that can be off
 * by minutes. It costs exactly one extra write per page load, and only on the first timestamp that
 * page needs.
 */

let offsetMs: number | null = null;
let inFlight: Promise<number> | null = null;

async function measure(sessionId: string): Promise<number> {
  const sentAt = Date.now();
  const { data, error } = await supabase
    .from('live_events')
    .insert({ session_id: sessionId, event_type: 'clock_sync', payload_json: {} })
    .select('created_at')
    .single();
  const returnedAt = Date.now();
  // A failed measurement must not stall the show — fall back to "no offset", which is exactly the
  // behaviour this app had before, rather than throwing inside a timer start.
  if (error || !data?.created_at) return 0;
  return new Date(data.created_at).getTime() - (sentAt + (returnedAt - sentAt) / 2);
}

/** Milliseconds to ADD to this browser's clock to get the database's clock. Measured once, then
 *  cached for the life of the page. Concurrent callers share a single in-flight measurement. */
export async function dbClockOffset(sessionId: string): Promise<number> {
  if (offsetMs !== null) return offsetMs;
  if (!inFlight) {
    inFlight = measure(sessionId).then(o => {
      offsetMs = o;
      inFlight = null;
      return o;
    });
  }
  return inFlight;
}

/** The offset already measured, or 0 if it hasn't been measured yet. For render-path use (the
 *  250ms countdown tick), which cannot await — it starts out uncorrected and snaps into line as
 *  soon as `warmDbClock` resolves. */
export function cachedDbClockOffset(): number {
  return offsetMs ?? 0;
}

/** Kick off the measurement without waiting for it. Call once on mount from any screen that
 *  displays a countdown, so the offset is already cached by the time the first timer starts. */
export function warmDbClock(sessionId: string): void {
  void dbClockOffset(sessionId).catch(() => {});
}

/** Now, on the database's clock. */
export async function dbNow(sessionId: string): Promise<Date> {
  return new Date(Date.now() + (await dbClockOffset(sessionId)));
}

/** Now, on the database's clock, using whatever offset has been measured so far. Safe to call
 *  during render. */
export function dbNowMs(): number {
  return Date.now() + cachedDbClockOffset();
}
