// Breathing pacer and a procedurally generated drone. No audio files, no
// network: everything here is synthesised so the scene stays self contained.

const CYCLE = [
  { label: 'breathe in', seconds: 4, from: 0.5, to: 1 },
  { label: 'hold', seconds: 2, from: 1, to: 1 },
  { label: 'breathe out', seconds: 6, from: 1, to: 0.5 },
];
const TOTAL = CYCLE.reduce((sum, step) => sum + step.seconds, 0);

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export function createBreath(ring, label) {
  let elapsed = 0;
  let lastLabel = '';

  return {
    update(dt) {
      elapsed = (elapsed + dt) % TOTAL;
      let cursor = 0;
      for (const step of CYCLE) {
        if (elapsed < cursor + step.seconds) {
          const t = (elapsed - cursor) / step.seconds;
          const scale = step.from + (step.to - step.from) * smooth(t);
          ring.style.transform = `scale(${scale.toFixed(3)})`;
          if (label && step.label !== lastLabel) {
            label.textContent = step.label;
            lastLabel = step.label;
          }
          return;
        }
        cursor += step.seconds;
      }
    },
  };
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let on = false;

  function build() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Brown-ish noise through a lowpass: surf and wind.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 520;
    lowpass.Q.value = 0.7;

    const windGain = ctx.createGain();
    windGain.gain.value = 0.55;

    const swell = ctx.createOscillator();
    swell.frequency.value = 0.055;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.3;
    swell.connect(swellDepth).connect(windGain.gain);

    source.connect(lowpass).connect(windGain).connect(master);
    source.start();
    swell.start();

    // A quiet triad underneath, drifting a little out of tune and back.
    for (const freq of [55, 82.5, 110, 164.81]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = freq > 120 ? 0.012 : 0.03;
      osc.connect(gain).connect(master);
      osc.start();

      const drift = ctx.createOscillator();
      drift.frequency.value = 0.02 + Math.random() * 0.05;
      const driftDepth = ctx.createGain();
      driftDepth.gain.value = freq * 0.004;
      drift.connect(driftDepth).connect(osc.frequency);
      drift.start();
    }

    return true;
  }

  return {
    get enabled() {
      return on;
    },
    async toggle() {
      if (!ctx && !build()) return false;
      if (ctx.state === 'suspended') await ctx.resume();
      on = !on;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(on ? 0.5 : 0, now + (on ? 2.5 : 1.5));
      return on;
    },
  };
}
