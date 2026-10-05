// Everything you hear is synthesised on the fly with WebAudio: no sample files.
// A small tiled room reverb glues it together (it is a salon, after all).

const rnd = (a, b) => a + Math.random() * (b - a);

export class SalonAudio {
  constructor() {
    this.ctx = null;
    this.musicOn = true;
    this.loops = {};
    this.lastPop = 0;
    this.lastBrush = 0;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.8, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.28;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.sfx.connect(this.reverbSend);

    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 0.32 : 0;
    this.music.connect(this.master);
    const musicVerb = ctx.createGain();
    musicVerb.gain.value = 0.35;
    this.music.connect(musicVerb).connect(this.reverb);

    this.amb = ctx.createGain();
    this.amb.gain.value = 0.5;
    this.amb.connect(this.master);

    this.noise = this._noiseBuffer(2.5, 'white');
    this.brown = this._noiseBuffer(4, 'brown');

    this._makeLoops();
    this._startRain();
    this._startMusic();
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Early tile reflections then a soft tail.
        const early = i < ctx.sampleRate * 0.04 && Math.random() < 0.02 ? 1.5 : 0;
        d[i] = ((Math.random() * 2 - 1) + early) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  _noiseBuffer(seconds, color) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  _noiseSource(buf = this.noise) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  _makeLoops() {
    const ctx = this.ctx;
    // Sprayer: hissy band-passed noise.
    {
      const src = this._noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 0.6;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 600;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(hp).connect(g).connect(this.sfx);
      src.start();
      this.loops.spray = { gain: g, filter: bp };
    }
    // Dryer: low rumble + motor whine.
    {
      const src = this._noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const motor = ctx.createOscillator();
      motor.type = 'sawtooth';
      motor.frequency.value = 180;
      const mg = ctx.createGain();
      mg.gain.value = 0.05;
      const mlp = ctx.createBiquadFilter();
      mlp.type = 'lowpass';
      mlp.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp).connect(g);
      motor.connect(mg).connect(mlp).connect(g);
      g.connect(this.sfx);
      src.start();
      motor.start();
      this.loops.dryer = { gain: g, filter: lp, motor };
    }
    // Clippers: buzzy square with amplitude flutter.
    {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 118;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 1.4;
      const trem = ctx.createOscillator();
      trem.frequency.value = 59;
      const tg = ctx.createGain();
      tg.gain.value = 0.35;
      const g = ctx.createGain();
      g.gain.value = 0;
      const amp = ctx.createGain();
      amp.gain.value = 0.6;
      trem.connect(tg).connect(amp.gain);
      osc.connect(bp).connect(amp).connect(g).connect(this.sfx);
      osc.start();
      trem.start();
      this.loops.clip = { gain: g, osc, filter: bp };
    }
    // Scrubbing: soft wet squelch noise.
    {
      const src = this._noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.sfx);
      src.start();
      this.loops.scrub = { gain: g, filter: bp };
    }
    // Drain gurgle.
    {
      const src = this._noiseSource(this.brown);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 320;
      bp.Q.value = 4;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      const lg = ctx.createGain();
      lg.gain.value = 140;
      lfo.connect(lg).connect(bp.frequency);
      lfo.start();
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.sfx);
      src.start();
      this.loops.drain = { gain: g };
    }
  }

  setLoop(name, level, param = 0) {
    const l = this.loops[name];
    if (!l) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(level, t, 0.05);
    if (name === 'dryer') {
      l.filter.frequency.setTargetAtTime(700 + param * 900, t, 0.1);
      l.motor.frequency.setTargetAtTime(150 + param * 90, t, 0.15);
    } else if (name === 'clip') {
      l.osc.frequency.setTargetAtTime(118 - param * 14, t, 0.03);
      l.filter.frequency.setTargetAtTime(1500 + param * 900, t, 0.03);
    } else if (name === 'spray') {
      l.filter.frequency.setTargetAtTime(2000 + param * 1600, t, 0.05);
    } else if (name === 'scrub') {
      l.filter.frequency.setTargetAtTime(600 + param * 700, t, 0.05);
    }
  }

  _startRain() {
    const ctx = this.ctx;
    const src = this._noiseSource(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    src.connect(lp).connect(g).connect(this.amb);
    src.start();
    const hiss = this._noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const hg = ctx.createGain();
    hg.gain.value = 0.025;
    hiss.connect(hp).connect(hg).connect(this.amb);
    hiss.start();
    // Individual drips on the window.
    const drip = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = rnd(1800, 3400);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.04);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(rnd(0.01, 0.03), t + 0.003);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(e).connect(this.amb);
      o.start(t);
      o.stop(t + 0.06);
      setTimeout(drip, rnd(60, 380));
    };
    drip();
  }

  // ---------------- One-shots ----------------
  _env(node, t, a, peak, d) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  pop(vol = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastPop < 0.03) return;
    this.lastPop = now;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f = rnd(700, 1500);
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 2.2, now + 0.03);
    const g = this.ctx.createGain();
    this._env(g, now, 0.002, 0.09 * vol, 0.05);
    o.connect(g).connect(this.sfx);
    o.start(now);
    o.stop(now + 0.08);
  }

  squeak() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 0.16;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1300, t0);
      o.frequency.exponentialRampToValueAtTime(2600 + i * 400, t0 + 0.11);
      const vib = this.ctx.createOscillator();
      vib.frequency.value = 38;
      const vg = this.ctx.createGain();
      vg.gain.value = 60;
      vib.connect(vg).connect(o.frequency);
      const g = this.ctx.createGain();
      this._env(g, t0, 0.01, 0.12, 0.12);
      o.connect(g).connect(this.sfx);
      o.start(t0);
      vib.start(t0);
      o.stop(t0 + 0.16);
      vib.stop(t0 + 0.16);
    }
  }

  // Formant-filtered saw "woof". size: 0 tiny yip, 1 big dog.
  bark(size = 0.6, times = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < times; i++) {
      const t = ctx.currentTime + i * rnd(0.22, 0.3);
      const f0 = 520 - size * 300;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 0.8, t);
      o.frequency.linearRampToValueAtTime(f0 * 1.15, t + 0.03);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.17);
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 900 - size * 250;
      f1.Q.value = 3;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 2100 - size * 500;
      f2.Q.value = 5;
      const g = ctx.createGain();
      this._env(g, t, 0.012, 0.5, 0.16);
      const nb = this._noiseSource();
      const ng = ctx.createGain();
      this._env(ng, t, 0.005, 0.08, 0.06);
      o.connect(f1).connect(g);
      o.connect(f2).connect(g);
      nb.connect(ng).connect(f1);
      g.connect(this.sfx);
      o.start(t);
      nb.start(t);
      o.stop(t + 0.25);
      nb.stop(t + 0.25);
    }
  }

  whine() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(900, t);
    o.frequency.linearRampToValueAtTime(1300, t + 0.25);
    o.frequency.linearRampToValueAtTime(800, t + 0.55);
    const g = ctx.createGain();
    this._env(g, t, 0.05, 0.08, 0.5);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.6);
  }

  coin(i = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + i * 0.07;
    const base = rnd(1900, 2300);
    for (const [ratio, amp] of [[1, 0.1], [2.76, 0.05], [5.4, 0.02]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * ratio;
      const g = this.ctx.createGain();
      this._env(g, t, 0.002, amp, 0.35);
      o.connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.4);
    }
  }

  clink(v = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = rnd(3000, 4200);
    const g = this.ctx.createGain();
    this._env(g, t, 0.001, 0.04 * v, 0.08);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.1);
  }

  shutter() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [dt, f] of [[0, 4200], [0.09, 2600]]) {
      const n = this._noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = f;
      hp.Q.value = 1;
      const g = ctx.createGain();
      this._env(g, t + dt, 0.001, 0.35, 0.05);
      n.connect(hp).connect(g).connect(this.sfx);
      n.start(t + dt);
      n.stop(t + dt + 0.08);
    }
    // Polaroid whirr.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 95;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.25);
    g.gain.setValueAtTime(0.05, t + 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t + 0.2);
    o.stop(t + 1);
  }

  bell() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const t = ctx.currentTime + i * 0.11;
      const car = ctx.createOscillator();
      car.frequency.value = 1568 + (i % 2) * 210;
      const mod = ctx.createOscillator();
      mod.frequency.value = car.frequency.value * 1.41;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(900, t);
      mg.gain.exponentialRampToValueAtTime(1, t + 0.8);
      mod.connect(mg).connect(car.frequency);
      const g = ctx.createGain();
      this._env(g, t, 0.002, 0.07, 1.1);
      car.connect(g).connect(this.sfx);
      car.start(t);
      mod.start(t);
      car.stop(t + 1.3);
      mod.stop(t + 1.3);
    }
  }

  brush(speed) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBrush < 0.09 || speed < 0.15) return;
    this.lastBrush = now;
    const n = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3500 + speed * 2500;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    this._env(g, now, 0.02, Math.min(0.12, 0.04 + speed * 0.05), 0.08);
    n.connect(bp).connect(g).connect(this.sfx);
    n.start(now);
    n.stop(now + 0.14);
  }

  snip() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const g = this.ctx.createGain();
    this._env(g, t, 0.001, 0.08, 0.03);
    n.connect(hp).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.05);
  }

  splat() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.12);
    const g = this.ctx.createGain();
    this._env(g, t, 0.005, 0.18, 0.12);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.16);
  }

  boing(pitch = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(420 * pitch, t + 0.08);
    o.frequency.exponentialRampToValueAtTime(260 * pitch, t + 0.25);
    const g = this.ctx.createGain();
    this._env(g, t, 0.01, 0.12, 0.25);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.3);
  }

  chime(notes = [0, 4, 7, 12], step = 0.09, vol = 0.09) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    notes.forEach((n, i) => {
      const t = t0 + i * step;
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 784 * Math.pow(2, n / 12);
      const g = this.ctx.createGain();
      this._env(g, t, 0.005, vol, 0.5);
      o.connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.6);
    });
  }

  click() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(500, t + 0.04);
    const g = this.ctx.createGain();
    this._env(g, t, 0.002, 0.08, 0.05);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.08);
  }

  shakeRattle(level = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;
    const am = this.ctx.createOscillator();
    am.frequency.value = 11;
    const amg = this.ctx.createGain();
    amg.gain.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * level, t + 0.1);
    g.gain.setValueAtTime(0.18 * level, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    const amp = this.ctx.createGain();
    amp.gain.value = 0.5;
    am.connect(amg).connect(amp.gain);
    n.connect(bp).connect(amp).connect(g).connect(this.sfx);
    n.start(t);
    am.start(t);
    n.stop(t + 1.4);
    am.stop(t + 1.4);
  }

  // ---------------- Music ----------------
  setMusic(on) {
    this.musicOn = on;
    if (this.ctx) this.music.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 0.4);
  }

  _startMusic() {
    const ctx = this.ctx;
    const bpm = 76;
    const beat = 60 / bpm;
    // Fmaj9 – Em7 – Dm9 – Bbmaj7(#11)-ish: warm, unhurried, rainy-window chords.
    const prog = [
      [53, 57, 60, 64, 67],
      [52, 55, 59, 62, 66],
      [50, 53, 57, 60, 64],
      [46, 50, 53, 57, 62],
    ];
    const scale = [65, 67, 69, 72, 74, 76, 79, 81];
    let next = ctx.currentTime + 0.5;
    let bar = 0;
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

    const keys = (m, t, dur, vol) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(m);
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = mtof(m) * 2.001;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(vol * 0.35, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(this.music);
      o.start(t);
      o2.start(t);
      o.stop(t + dur + 0.05);
      o2.stop(t + dur + 0.05);
    };
    const pluck = (m, t, vol) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = mtof(m);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 1);
    };
    const shaker = (t, vol) => {
      const n = this._noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      n.connect(hp).connect(g).connect(this.music);
      n.start(t);
      n.stop(t + 0.1);
    };
    const bass = (m, t, dur) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(m - 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + dur + 0.05);
    };

    const schedule = () => {
      if (!this.ctx) return;
      while (next < ctx.currentTime + 0.6) {
        const chord = prog[bar % prog.length];
        const barLen = beat * 4;
        chord.forEach((m, i) => keys(m, next + i * 0.012, barLen * 0.95, 0.045));
        bass(chord[0], next, beat * 2.5);
        bass(chord[0] + 7, next + beat * 2.5, beat * 1.4);
        for (let s = 0; s < 8; s++) shaker(next + s * beat * 0.5 + (s % 2) * 0.03, s % 2 ? 0.012 : 0.02);
        // Sparse kalimba melody, rain-drop rhythm.
        for (let s = 0; s < 8; s++) {
          if (Math.random() < (s % 2 ? 0.25 : 0.42)) {
            pluck(scale[Math.floor(Math.random() * scale.length)], next + s * beat * 0.5, 0.05);
          }
        }
        next += barLen;
        bar++;
      }
      setTimeout(schedule, 200);
    };
    schedule();
  }
}
