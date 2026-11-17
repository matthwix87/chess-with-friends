// All sounds are synthesized at runtime with the WebAudio API (no audio files).

let ctx = null;
let enabled = true;

function audio() {
  if (!enabled) return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function setSoundEnabled(on) { enabled = !!on; }

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio() { audio(); }

// A short "wooden knock": filtered noise burst plus a quick low sine thump.
function knock(c, t, { freq = 180, gain = 0.5, decay = 0.07, cutoff = 1800 } = {}) {
  const len = Math.floor(c.sampleRate * decay);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = cutoff; bp.Q.value = 0.9;
  const ng = c.createGain(); ng.gain.value = gain * 0.9;
  noise.connect(bp).connect(ng).connect(c.destination);
  noise.start(t);

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + decay);
  const og = c.createGain();
  og.gain.setValueAtTime(gain, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + decay * 1.4);
  osc.connect(og).connect(c.destination);
  osc.start(t); osc.stop(t + decay * 1.5);
}

function tone(c, t, freq, dur, gain = 0.18, type = 'triangle') {
  const osc = c.createOscillator();
  osc.type = type; osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t); osc.stop(t + dur + 0.02);
}

export function playSound(kind) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.005;
  switch (kind) {
    case 'move': knock(c, t); break;
    case 'capture': knock(c, t, { freq: 140, gain: 0.7, cutoff: 1200 }); knock(c, t + 0.045, { freq: 220, gain: 0.35, cutoff: 2400 }); break;
    case 'castle': knock(c, t); knock(c, t + 0.09, { freq: 200 }); break;
    case 'check': knock(c, t, { gain: 0.5 }); tone(c, t + 0.02, 880, 0.18, 0.12, 'square'); break;
    case 'promote': knock(c, t); tone(c, t + 0.03, 660, 0.12); tone(c, t + 0.12, 990, 0.18); break;
    case 'start': tone(c, t, 523, 0.15); tone(c, t + 0.12, 784, 0.25); break;
    case 'end': tone(c, t, 392, 0.3); tone(c, t + 0.15, 494, 0.3); tone(c, t + 0.3, 587, 0.5); break;
    case 'notify': tone(c, t, 740, 0.12, 0.12, 'sine'); tone(c, t + 0.1, 988, 0.16, 0.12, 'sine'); break;
    case 'lowtime': tone(c, t, 1200, 0.06, 0.1, 'square'); break;
    case 'illegal': tone(c, t, 160, 0.12, 0.12, 'sawtooth'); break;
    default: knock(c, t);
  }
}
