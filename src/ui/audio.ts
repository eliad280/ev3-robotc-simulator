import { SoundEvent } from '../sim/simulation';

let ctx: AudioContext | undefined;

/** Must be called from a user gesture (e.g. the Run click) so the browser allows sound. */
export function unlockAudio() {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function playTone(e: SoundEvent, muted: boolean) {
  if (!ctx || muted || e.volume <= 0) return;
  const start = ctx.currentTime + e.delay / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = Math.max(20, Math.min(10000, e.frequency));
  const level = (e.volume / 100) * 0.08;
  gain.gain.setValueAtTime(level, start);
  gain.gain.setValueAtTime(level, start + Math.max(0.01, e.ms / 1000 - 0.01));
  gain.gain.linearRampToValueAtTime(0, start + e.ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + e.ms / 1000 + 0.02);
}
