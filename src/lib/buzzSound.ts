// Self-contained buzzer sound — a short synthesized tone via Web Audio API, so no external
// audio file needs to be hosted or bundled. Safe to call from any client component.
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Short, sharp buzz — for the team that just pressed the button. */
export function playBuzzSound() {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

/** Brighter double-beep — for Host/Display announcing a new buzz-in. */
export function playBuzzAlert() {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  try {
    [0, 0.15].forEach(delay => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx!.currentTime + delay);
      gain.gain.setValueAtTime(0.2, audioCtx!.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx!.currentTime + delay + 0.12);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(audioCtx!.currentTime + delay);
      osc.stop(audioCtx!.currentTime + delay + 0.12);
    });
  } catch {}
}
