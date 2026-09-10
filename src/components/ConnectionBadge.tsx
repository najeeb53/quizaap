'use client';

import type { LiveStatus } from '@/lib/liveConnection';

/**
 * Says out loud whether this screen is still receiving live updates.
 *
 * Deliberately invisible while healthy: a green "connected" pill on the projector all night is
 * noise, and the host has enough to look at. It only appears when something is actually wrong —
 * which is exactly the state that used to be indistinguishable from a quiet moment in the show.
 *
 * `variant` matches the surrounding screen: the host and projector are dark, a team's phone is light.
 */
export function ConnectionBadge({ status, variant = 'dark', className = '' }: {
  status: LiveStatus;
  variant?: 'dark' | 'light';
  className?: string;
}) {
  if (status === 'live') return null;

  const label =
    status === 'offline' ? 'No internet — retrying' :
    status === 'connecting' ? 'Connecting…' :
    'Reconnecting — screen may be behind';

  const tone = status === 'offline'
    ? (variant === 'dark' ? 'bg-red-950/80 text-red-200 border-red-700' : 'bg-red-50 text-red-700 border-red-200')
    : (variant === 'dark' ? 'bg-amber-950/80 text-amber-200 border-amber-700' : 'bg-amber-50 text-amber-800 border-amber-200');

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone} ${className}`}
    >
      <span className={`h-2 w-2 rounded-full ${status === 'offline' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} />
      {label}
    </span>
  );
}
