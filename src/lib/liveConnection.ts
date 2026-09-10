'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeping a live screen actually live.
 *
 * Every screen in this app is driven by a Supabase realtime channel. When one drops — a wifi blip,
 * the host's laptop sleeping, a phone backgrounding itself — the screen does not error. It just
 * stops updating, silently, showing whatever it last knew. The host reads a stale buzzer list and
 * concludes nobody buzzed; the projector sits on the previous question. Nothing on screen suggests
 * anything is wrong, which is the worst possible failure mode in front of an audience.
 *
 * So this hook does three things:
 *
 *  1. Reports the channel's real state, so the screen can SAY it is reconnecting.
 *  2. Re-reads everything from the database whenever the connection comes back, because a channel
 *     that was down missed events outright — realtime has no replay, so reconnecting alone leaves
 *     the screen confidently wrong.
 *  3. Keeps a heartbeat resync running regardless. If realtime never recovers, the screen quietly
 *     degrades to polling instead of freezing. Slower, but it converges — and a show that runs a
 *     few seconds behind beats a show that has stopped.
 *
 * Usage:
 *
 *     const { status, channelKey, onChannelStatus } = useLiveConnection(refreshAll);
 *
 *     useEffect(() => {
 *       const sub = supabase.channel(`host:${sessionId}`)
 *         .on('postgres_changes', {...}, handler)
 *         .subscribe(onChannelStatus);          // <- report status
 *       return () => { supabase.removeChannel(sub); };
 *     }, [sessionId, channelKey, onChannelStatus]);   // <- channelKey forces a rebuild
 */

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** While disconnected, re-read everything this often — the polling fallback. */
const HEARTBEAT_DOWN_MS = 8000;
/** While connected, re-read this often anyway. Guards the nastiest case: a socket that reports
 *  SUBSCRIBED but has stopped delivering, where nothing else would ever notice. */
const HEARTBEAT_UP_MS = 60000;
/** How long to let Supabase's own auto-rejoin try before tearing the channel down and rebuilding. */
const REBUILD_AFTER_MS = 5000;
/** Collapse resync bursts (reconnect + visibility + heartbeat can all fire together). */
const MIN_RESYNC_GAP_MS = 800;

export function useLiveConnection(resync: () => void | Promise<void>) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [channelKey, setChannelKey] = useState(0);

  // The caller's resync usually changes identity every render; held in a ref so nothing below has
  // to depend on it (and so the channel is never rebuilt just because a callback was recreated).
  const resyncRef = useRef(resync);
  useEffect(() => { resyncRef.current = resync; }, [resync]);

  const lastResyncAt = useRef(0);
  const runResync = useCallback(() => {
    const now = Date.now();
    if (now - lastResyncAt.current < MIN_RESYNC_GAP_MS) return;
    lastResyncAt.current = now;
    void Promise.resolve(resyncRef.current()).catch(() => {});
  }, []);

  // Mirrored in a ref so the transition check below is a plain read, not a side effect inside a
  // state updater — React can invoke an updater more than once, which would double-fire the resync.
  const statusRef = useRef<LiveStatus>('connecting');
  const applyStatus = useCallback((next: LiveStatus) => {
    const prev = statusRef.current;
    if (prev === next) return;
    statusRef.current = next;
    setStatus(next);
    // Just came back: whatever happened while we were away never arrived. Re-read from scratch.
    if (next === 'live' && prev !== 'live') runResync();
  }, [runResync]);

  /** Pass straight to `.subscribe()`. */
  const onChannelStatus = useCallback((s: string) => {
    if (s === 'SUBSCRIBED') { applyStatus('live'); return; }
    if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
      applyStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting');
    }
  }, [applyStatus]);

  // Rebuild the channel if it stays down. Supabase retries on its own, but a hard socket close
  // (laptop lid) can leave a channel that never rejoins; recreating it reliably does.
  useEffect(() => {
    if (status === 'live') return;
    const t = setTimeout(() => {
      if (statusRef.current !== 'live') setChannelKey(k => k + 1);
    }, REBUILD_AFTER_MS);
    return () => clearTimeout(t);
  }, [status, channelKey]);

  // Heartbeat — fast while down, slow while up.
  useEffect(() => {
    const period = status === 'live' ? HEARTBEAT_UP_MS : HEARTBEAT_DOWN_MS;
    const t = setInterval(() => { runResync(); }, period);
    return () => clearInterval(t);
  }, [status, runResync]);

  // Network flaps and tab/lid wake-ups. A laptop coming out of sleep fires visibilitychange long
  // before the socket notices it died, so this is usually the first hint anything was wrong.
  useEffect(() => {
    const onOnline = () => { applyStatus('reconnecting'); setChannelKey(k => k + 1); };
    const onOffline = () => applyStatus('offline');
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      runResync();
      if (statusRef.current !== 'live') setChannelKey(k => k + 1);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    if (typeof navigator !== 'undefined' && !navigator.onLine) applyStatus('offline');
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [applyStatus, runResync]);

  return { status, channelKey, onChannelStatus };
}

/**
 * Holds a screen wake lock, so the machine doesn't blank mid-show.
 *
 * The projector is the obvious case — a laptop on battery power turning the big screen black
 * between questions — but it matters on a team's phone too: a locked phone can't buzz.
 *
 * The lock is released by the browser whenever the tab is hidden, so it has to be re-acquired on
 * every return to visibility rather than requested once. Unsupported browsers (and a refusal, which
 * Safari gives on battery saver) fail quietly — there is nothing useful to tell the user.
 */
export function useWakeLock(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release?: () => Promise<void> }> } }).wakeLock;
    if (!wakeLock) return;

    let sentinel: { release?: () => Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || sentinel || document.visibilityState !== 'visible') return;
      try {
        sentinel = await wakeLock.request('screen');
        (sentinel as unknown as EventTarget).addEventListener?.('release', () => { sentinel = null; });
        if (cancelled) { void sentinel.release?.(); sentinel = null; }
      } catch { /* not supported, or refused on battery saver */ }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); else sentinel = null; };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { void sentinel?.release?.(); } catch {}
      sentinel = null;
    };
  }, [enabled]);
}
