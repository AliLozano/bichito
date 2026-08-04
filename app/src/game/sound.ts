// Tiny synth for combat SFX — no binary assets (CSP-safe, self-contained). Everything
// is generated with the Web Audio API through a single master gain, which the "Local"
// settings volume slider controls. Muted at volume 0.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.6;

function ac(): AudioContext | null {
  if (ctx) return ctx;
  // headless (the bot runs the same engine in Node): no Web Audio -> all SFX no-op.
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

// AudioContext often starts suspended until a user gesture — call this on the first
// keypress (entering / swinging) so sound actually plays.
export function resumeAudio() {
  const c = ac();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}

function tone(freq: number, dur: number, type: OscillatorType, peak: number, glideTo?: number) {
  const c = ac();
  if (!c || !master || volume <= 0) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, freq: number, peak: number, q = 0.8) {
  const c = ac();
  if (!c || !master || volume <= 0) return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export const sfx = {
  swing: () => noise(0.12, 1500, 0.22), // whoosh
  art: () => {
    noise(0.24, 800, 0.4); // big whoosh
    tone(180, 0.28, "sawtooth", 0.18, 90); // low sweep
  },
  hit: () => {
    tone(130, 0.16, "sine", 0.5, 70); // thud
    noise(0.08, 320, 0.28);
  },
  clash: () => {
    tone(2300, 0.13, "triangle", 0.32); // metallic cling
    tone(3300, 0.1, "square", 0.14);
  },
  ready: () => tone(880, 0.12, "sine", 0.18), // charge fully loaded
  enemySwing: () => noise(0.1, 1100, 0.1), // faint — the opponent swung
};
