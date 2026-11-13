// Sound for the scroll film. The effects are real recordings from Freesound (CC0); the music was generated with ACE-Step.
// Off until the visitor turns it on (browsers require a tap first).
// A film played by scrolling has no fixed timeline, so nothing here is a soundtrack: there is a music bed
// and a wind bed that just run, a wagon rumble whose level follows how fast the film is moving, and short
// sounds that fire when the film passes the frame they belong to.
//
//   const sound = new FilmSound(); button.onclick = () => sound.toggle();
//   new ScrollFilm({ ..., onUpdate: ({ index }) => sound.frame(index * framesPerIndex) });

const LOOPS = {            // file, where the seamless loop sits inside it (seconds), level
  music:  { src: "sound/music.mp3",  from: 0.25, length: 54.0,  gain: 0.56 },
  wind:   { src: "sound/wind.mp3",   from: 0.25, length: 16.0,  gain: 0.38 },
  rumble: { src: "sound/rumble.mp3", from: 0.25, length: 15.0,  gain: 0.0 },
};
const SHOTS = { gate: "sound/gate.mp3", gate2: "sound/gate2.mp3", clack: "sound/clack.mp3", lantern: "sound/lantern.mp3", bump: "sound/bump.mp3", keys: "sound/keys.mp3" };
// Film frame at which each one-shot plays, and how loud.
const CUES = [
  [112, "gate", 0.8], [152, "gate2", 0.3], [156, "gate", 0.18],
  ...Array.from({ length: 10 }, (_, i) => [124 + i * 4, "clack", 0.4]),
  ...Array.from({ length: 15 }, (_, i) => [127 + i * 6, "lantern", 0.5]),
  [296, "bump", 0.6], [318, "keys", 0.8],
].sort((a, b) => a[0] - b[0]);
// How much wagon there is to hear at a given frame: none until they roll, most while riding with the train.
const wagons = (f) => f < 138 ? 0 : f < 150 ? (f - 138) / 12 * 0.6 : f < 228 ? 0.6 : f < 296 ? 1 : f < 322 ? 0.35 : f < 334 ? 0.2 : 0.5;

export class FilmSound {
  constructor() { this.on = false; this.ready = false; this.last = null; this.speed = 0; this.lastShot = {}; }

  async toggle() {
    if (!this.ctx) await this.start();
    this.on = !this.on;
    this.master.gain.setTargetAtTime(this.on ? 1.0 : 0, this.ctx.currentTime, 0.25);
    if (this.on) await this.ctx.resume();
    return this.on;
  }

  async start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx(); this.master = this.ctx.createGain(); this.master.gain.value = 0; this.master.connect(this.ctx.destination);
    const load = async (src) => this.ctx.decodeAudioData(await (await fetch(src)).arrayBuffer());
    this.shots = {}; this.gains = {};
    await Promise.all([
      ...Object.entries(LOOPS).map(async ([name, l]) => {
        try {
          const node = this.ctx.createBufferSource(); node.buffer = await load(l.src); node.loop = true;
          node.loopStart = l.from; node.loopEnd = Math.min(l.from + l.length, node.buffer.duration);
          const g = this.ctx.createGain(); g.gain.value = l.gain; node.connect(g).connect(this.master); node.start(0, l.from); this.gains[name] = g;
        } catch { /* a missing bed is not fatal */ }
      }),
      ...Object.entries(SHOTS).map(async ([name, src]) => { try { this.shots[name] = await load(src); } catch { /* skip */ } }),
    ]);
    this.ready = true;
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.ctx.suspend(); else if (this.on) this.ctx.resume(); });
  }

  shot(name, gain) {
    const buf = this.shots[name], now = this.ctx.currentTime;
    if (!buf || now - (this.lastShot[name] || -9) < 0.09) return;      // scrolling fast must not machine-gun a sound
    this.lastShot[name] = now;
    const node = this.ctx.createBufferSource(); node.buffer = buf; node.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = this.ctx.createGain(); g.gain.value = gain; node.connect(g).connect(this.master); node.start();
  }

  // Call on every film update with the current film frame (0..359).
  frame(f) {
    if (!this.ready) { this.last = f; return; }
    const prev = this.last ?? f; this.last = f;
    const moved = Math.abs(f - prev); this.speed += (Math.min(moved, 4) - this.speed) * 0.2;
    if (this.on && f > prev && f - prev < 40) for (const [at, name, gain] of CUES) if (at > prev && at <= f) this.shot(name, gain);
    const g = this.gains.rumble;
    if (g) g.gain.setTargetAtTime(wagons(f) * (0.12 + 0.6 * Math.min(1, this.speed / 0.7)), this.ctx.currentTime, 0.18);
  }
}
