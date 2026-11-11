// Procedural sound (Web Audio API only: no audio files, no network).
//
//   engine   two detuned oscillators with a soft custom waveform + a sub
//            oscillator, through a low-pass whose cutoff follows rpm and
//            throttle; fake gearbox so pitch steps instead of whining upward
//   tyres    rolling rumble (brown noise) by speed, band-passed skid noise and
//            a faint squeal by lateral slip on sealed surfaces, a crackly
//            crunch texture on grass / sand / gravel / rough ground
//   wind     faint high-passed noise rising with speed
//   one-shots  thump on building / tree impacts, splash on entering water
//
// Signal chain: voices -> bus -> master gain (mute) -> high-pass 45 Hz ->
// low-pass 7 kHz -> compressor -> limiter -> speakers. The context is created
// on the first user gesture (key, pointer, touch, gamepad button), suspended
// while the page is hidden and resumed when it is shown again.
//
// Reads only public car fields: speed, vF, vL, surface, impact, waterTime.

// ---------------------------------------------------------------- tuning
export const TUNE = {
  masterVolume: 0.5,      // overall level before the compressor / limiter
  engineVolume: 0.32,     // engine level at full throttle
  idleRpm: 850,
  maxRpm: 6600,
  firingPerRev: 2,        // 4-cylinder four-stroke: 2 firings per revolution
  // upshift speeds (m/s) per gear; the last gear tops out at the car's 50 m/s
  upshift: [12.5, 21, 29.5, 38.5],
  shiftRpm: 6100,         // rpm reached at each upshift speed
  topGearRpm: 6300,       // rpm at 50 m/s in top gear
  downshiftFrac: 0.72,    // drop a gear below this fraction of the lower gear's upshift speed
  shiftTime: 0.16,        // s of reduced load during a gear change
  cutoffBase: 260,        // engine low-pass (Hz) at idle, off throttle
  cutoffPerRpm: 0.16,     // + Hz per rpm
  cutoffLoad: 900,        // + Hz at full throttle
  cutoffMax: 2400,
  skidVolume: 0.2,
  squealVolume: 0.035,
  rollVolume: 0.16,
  offroadVolume: 0.2,
  windVolume: 0.05,
  impactVolume: 0.75,
  splashVolume: 0.5,
};

const STORAGE_KEY = 'coastline-cruiser.muted';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function loadMuted() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
}
function saveMuted(m) {
  try { localStorage.setItem(STORAGE_KEY, m ? '1' : '0'); } catch (_) { /* private mode etc. */ }
}

export class GameAudio {
  // opts.context: use this (e.g. an OfflineAudioContext) instead of creating
  // one on the first gesture; no DOM listeners are attached in that case.
  constructor(opts = {}) {
    this.AC = window.AudioContext || window.webkitAudioContext || null;
    this.supported = !!(this.AC || opts.context);
    this.ctx = null;
    this.muted = loadMuted();
    this.button = null;
    this.rpm = TUNE.idleRpm;
    this.gear = 1;
    this.load = 0;
    this.shiftTimer = 0;
    this.prevImpact = 0;
    this.impactCooldown = 0;
    this.wasInWater = false;
    this.padPrev = false;
    // readable state for tests / debugging
    this.state = {
      contextState: 'none', muted: this.muted, rpm: this.rpm, gear: 1,
      engineFreq: 0, engineCutoff: 0, engineGain: 0, skidGain: 0, squealGain: 0,
      rollGain: 0, offroadGain: 0, windGain: 0, masterTarget: 0,
      impacts: 0, lastImpact: 0, splashes: 0, errors: 0,
    };
    if (opts.context) { this.build(opts.context); return; }
    if (!this.supported) return;

    const unlock = () => this.start();
    for (const ev of ['keydown', 'pointerdown', 'touchstart', 'mousedown']) {
      addEventListener(ev, unlock, { capture: true, passive: true });
    }
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggleMute();
    });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (!this.muted) this.ctx.resume().catch(() => {});
    });
  }

  // HUD mute button
  bindButton(el) {
    if (!el) return;
    this.button = el;
    if (!this.supported) { el.hidden = true; return; }
    el.addEventListener('pointerdown', (e) => { this.start(); this.toggleMute(); e.preventDefault(); e.stopPropagation(); });
    this.refreshButton();
  }

  refreshButton() {
    if (!this.button) return;
    this.button.textContent = this.muted ? 'MUTED' : 'SOUND';
    this.button.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
  }

  // create / resume the context; must run inside a user gesture handler
  start() {
    if (!this.supported) return;
    try {
      if (!this.ctx) {
        this.build(new this.AC({ latencyHint: 'interactive' }));
      }
      if (this.muted) { if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }
      else if (this.ctx.state !== 'running' && !document.hidden) this.ctx.resume().catch(() => {});
    } catch (e) {
      this.state.errors++;
      this.supported = false;
      console.warn('Audio unavailable:', e);
    }
  }

  setMuted(m) {
    this.muted = !!m;
    this.state.muted = this.muted;
    saveMuted(this.muted);
    this.refreshButton();
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : TUNE.masterVolume, t, 0.03);
    this.state.masterTarget = this.muted ? 0 : TUNE.masterVolume;
    if (this.muted) {
      // save battery once the fade-out is done
      clearTimeout(this.suspendTimer);
      this.suspendTimer = setTimeout(() => { if (this.muted && c.state === 'running' && c.suspend) c.suspend().catch(() => {}); }, 250);
    } else if (!document.hidden && c.resume) {
      clearTimeout(this.suspendTimer);
      c.resume().catch(() => {});
    }
  }

  toggleMute() { this.setMuted(!this.muted); }

  // ---------------------------------------------------------------- graph
  build(ctx) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    const P = (param, v) => { param.setValueAtTime(v, t); return param; };

    // output chain
    const limiter = ctx.createDynamicsCompressor();
    P(limiter.threshold, -2); P(limiter.knee, 0); P(limiter.ratio, 20); P(limiter.attack, 0.001); P(limiter.release, 0.1);
    const comp = ctx.createDynamicsCompressor();
    P(comp.threshold, -16); P(comp.knee, 10); P(comp.ratio, 5); P(comp.attack, 0.004); P(comp.release, 0.25);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; P(lp.frequency, 7000); P(lp.Q, 0.5);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; P(hp.frequency, 45); P(hp.Q, 0.6);
    this.master = ctx.createGain();
    P(this.master.gain, this.muted ? 0 : TUNE.masterVolume);
    this.state.masterTarget = this.muted ? 0 : TUNE.masterVolume;
    this.bus = ctx.createGain();
    this.bus.connect(this.master); this.master.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(limiter);
    limiter.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    limiter.connect(this.analyser);
    this.out = limiter;

    // noise sources
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2);
    const white = ctx.createBuffer(1, len, sr), brown = ctx.createBuffer(1, len, sr), crackle = ctx.createBuffer(1, len, sr);
    const w = white.getChannelData(0), b = brown.getChannelData(0), c = crackle.getChannelData(0);
    let last = 0, env = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
      // sparse decaying grains: gravel / grass crunch
      if (Math.random() < 160 / sr) env = 0.4 + Math.random() * 0.6;
      env *= Math.exp(-1 / (0.004 * sr));
      c[i] = (Math.random() * 2 - 1) * env * 0.9 + w[i] * 0.06;
    }
    // remove DC from the brown buffer so the loop seam does not click
    let mean = 0; for (let i = 0; i < len; i++) mean += b[i]; mean /= len;
    for (let i = 0; i < len; i++) b[i] -= mean;
    const fade = Math.floor(sr * 0.01);
    for (const d of [w, b, c]) for (let i = 0; i < fade; i++) { const k = i / fade; d[i] *= k; d[len - 1 - i] *= k; }
    this.whiteBuf = white;
    const loop = (buf, offset) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(t, offset); return s; };
    const whiteSrc = loop(white, 0), whiteSrc2 = loop(white, 0.97), brownSrc = loop(brown, 0.3);
    this.crackleSrc = loop(crackle, 0);

    // engine: soft waveform (decaying harmonics, slightly hollow odd ones)
    const N = 28, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) im[n] = (1 / Math.pow(n, 1.25)) * (n % 2 ? 0.8 : 1) * (n === 2 ? 1.3 : 1);
    const wave = ctx.createPeriodicWave(re, im);
    this.engOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.engOsc[0].setPeriodicWave(wave); this.engOsc[1].setPeriodicWave(wave);
    P(this.engOsc[0].detune, -6); P(this.engOsc[1].detune, 7);
    this.engSub = ctx.createOscillator(); this.engSub.type = 'sine';
    const subGain = ctx.createGain(); P(subGain.gain, 0.5);
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; P(this.engFilter.Q, 1.1);
    P(this.engFilter.frequency, TUNE.cutoffBase);
    this.engGain = ctx.createGain(); P(this.engGain.gain, 0);
    const oscMix = ctx.createGain(); P(oscMix.gain, 0.45);
    // gentle idle wobble (slightly uneven firing)
    const wob = ctx.createOscillator(); P(wob.frequency, 6.3);
    this.wobGain = ctx.createGain(); P(this.wobGain.gain, 8);
    wob.connect(this.wobGain);
    for (const o of this.engOsc) { o.connect(oscMix); this.wobGain.connect(o.detune); }
    oscMix.connect(this.engFilter);
    this.engSub.connect(subGain); subGain.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.bus);
    for (const o of [...this.engOsc, this.engSub, wob]) o.start(t);
    this.setEngineFreq(this.rpm, t);

    // skid: band-passed white noise + faint wobbling squeal tone
    this.skidFilter = ctx.createBiquadFilter(); this.skidFilter.type = 'bandpass'; P(this.skidFilter.frequency, 1100); P(this.skidFilter.Q, 3.5);
    this.skidGain = ctx.createGain(); P(this.skidGain.gain, 0);
    whiteSrc.connect(this.skidFilter); this.skidFilter.connect(this.skidGain); this.skidGain.connect(this.bus);
    this.squeal = ctx.createOscillator(); this.squeal.type = 'triangle'; P(this.squeal.frequency, 820);
    const sqLfo = ctx.createOscillator(); P(sqLfo.frequency, 4.7);
    const sqLfoGain = ctx.createGain(); P(sqLfoGain.gain, 30);
    sqLfo.connect(sqLfoGain); sqLfoGain.connect(this.squeal.frequency);
    const sqFilter = ctx.createBiquadFilter(); sqFilter.type = 'lowpass'; P(sqFilter.frequency, 1600);
    this.squealGain = ctx.createGain(); P(this.squealGain.gain, 0);
    this.squeal.connect(sqFilter); sqFilter.connect(this.squealGain); this.squealGain.connect(this.bus);
    this.squeal.start(t); sqLfo.start(t);

    // rolling rumble on sealed surfaces
    this.rollFilter = ctx.createBiquadFilter(); this.rollFilter.type = 'lowpass'; P(this.rollFilter.frequency, 380); P(this.rollFilter.Q, 0.7);
    this.rollGain = ctx.createGain(); P(this.rollGain.gain, 0);
    brownSrc.connect(this.rollFilter); this.rollFilter.connect(this.rollGain); this.rollGain.connect(this.bus);

    // off-road crunch
    this.offFilter = ctx.createBiquadFilter(); this.offFilter.type = 'lowpass'; P(this.offFilter.frequency, 1800); P(this.offFilter.Q, 0.7);
    const offBody = ctx.createBiquadFilter(); offBody.type = 'lowpass'; P(offBody.frequency, 260);
    const offBodyGain = ctx.createGain(); P(offBodyGain.gain, 0.6);
    this.offGain = ctx.createGain(); P(this.offGain.gain, 0);
    this.crackleSrc.connect(this.offFilter); this.offFilter.connect(this.offGain);
    brownSrc.connect(offBody); offBody.connect(offBodyGain); offBodyGain.connect(this.offGain);
    this.offGain.connect(this.bus);

    // wind
    const windHp = ctx.createBiquadFilter(); windHp.type = 'highpass'; P(windHp.frequency, 350);
    const windLp = ctx.createBiquadFilter(); windLp.type = 'lowpass'; P(windLp.frequency, 1400);
    this.windGain = ctx.createGain(); P(this.windGain.gain, 0);
    whiteSrc2.connect(windHp); windHp.connect(windLp); windLp.connect(this.windGain); this.windGain.connect(this.bus);

    if (ctx.addEventListener) ctx.addEventListener('statechange', () => { this.state.contextState = ctx.state; });
    this.state.contextState = ctx.state;
  }

  setEngineFreq(rpm, t) {
    const f = (rpm / 60) * TUNE.firingPerRev;
    const tc = 0.03;
    this.engOsc[0].frequency.setTargetAtTime(f, t, tc);
    this.engOsc[1].frequency.setTargetAtTime(f, t, tc);
    this.engSub.frequency.setTargetAtTime(f * 0.5, t, tc);
    this.state.engineFreq = f;
  }

  // ---------------------------------------------------------------- per frame
  gearRatio(g) {
    const U = TUNE.upshift;
    return g <= U.length ? TUNE.shiftRpm / U[g - 1] : TUNE.topGearRpm / 50;
  }

  update(dt, car, inp) {
    if (!this.supported) return;
    // gamepad button press counts as a gesture attempt
    if (!this.ctx || this.ctx.state !== 'running') this.pollGamepad();
    const ctx = this.ctx;
    if (!ctx) return;
    this.state.contextState = ctx.state;
    if (ctx.state !== 'running') { this.track(dt, car, inp); return; }
    try { this.apply(dt, car, inp, ctx.currentTime); } catch (e) {
      if (!this.state.errors++) console.warn('audio update failed', e);
    }
  }

  pollGamepad() {
    if (!navigator.getGamepads) return;
    let any = false;
    try {
      for (const p of navigator.getGamepads()) if (p && p.connected) for (const b of p.buttons) if (b.pressed) any = true;
    } catch (_) { return; }
    if (any && !this.padPrev && (!navigator.userActivation || navigator.userActivation.hasBeenActive || this.ctx)) this.start();
    this.padPrev = any;
  }

  // keep edge detectors current while silent, so nothing fires on resume
  track(dt, car) {
    this.prevImpact = car.impact;
    this.wasInWater = car.surface === 'water';
  }

  apply(dt, car, inp, t) {
    const T = TUNE;
    const speed = car.speed;
    const vF = Math.abs(car.vF);
    const thr = inp ? clamp(Math.max(inp.throttle, car.vF < -0.5 ? inp.brake : 0), 0, 1) : 0;
    const surf = car.surface;
    const sealed = surf === 'road' || surf === 'paved';
    const water = surf === 'water';

    // --- gearbox
    const U = T.upshift;
    if (car.vF < -0.5) this.gear = 1; // reverse uses first gear's ratio
    else {
      while (this.gear <= U.length && vF > U[this.gear - 1]) { this.gear++; this.shiftTimer = T.shiftTime; }
      while (this.gear > 1 && vF < U[this.gear - 2] * T.downshiftFrac) { this.gear--; this.shiftTimer = T.shiftTime * 0.7; }
    }
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    // wheel-driven rpm; at low speed the "clutch" lets throttle rev it up
    const loose = sealed ? 0 : thr * 0.12; // wheelspin on loose ground
    let target = vF * this.gearRatio(this.gear) * (1 + loose);
    const clutch = clamp(1 - vF / 6, 0, 1);
    target = Math.max(target, T.idleRpm + clutch * thr * 2200);
    if (water) target = Math.max(target, T.idleRpm + thr * 2600); // wheels spinning in water
    target = clamp(target, T.idleRpm, T.maxRpm);
    const k = target < this.rpm ? (this.shiftTimer > 0 ? 18 : 6) : 7;
    this.rpm += (target - this.rpm) * Math.min(1, dt * k);
    // engine load: throttle, eased, dipping during a shift
    const loadTarget = this.shiftTimer > 0 ? thr * 0.25 : thr;
    this.load += (loadTarget - this.load) * Math.min(1, dt * (loadTarget > this.load ? 10 : 6));
    const rpmN = (this.rpm - T.idleRpm) / (T.maxRpm - T.idleRpm);

    this.setEngineFreq(this.rpm, t);
    let cutoff = T.cutoffBase + this.rpm * T.cutoffPerRpm + this.load * T.cutoffLoad;
    cutoff = Math.min(T.cutoffMax, cutoff);
    if (water) cutoff = Math.min(cutoff, 320);
    this.engFilter.frequency.setTargetAtTime(cutoff, t, 0.04);
    const eg = T.engineVolume * (0.38 + 0.42 * this.load + 0.2 * rpmN) * (water ? 0.6 : 1);
    this.engGain.gain.setTargetAtTime(eg, t, 0.05);
    this.wobGain.gain.setTargetAtTime(9 * (1 - rpmN) + 2, t, 0.1);

    // --- tyres
    const slip = Math.abs(car.vL);
    const spdF = clamp(speed / 6, 0, 1);
    let skid = clamp((slip - 1.0) / 5, 0, 1) * spdF;
    if (inp && inp.brake > 0 && car.vF > 6) skid = Math.max(skid, 0.35 * inp.brake * clamp((car.vF - 6) / 15, 0, 1));
    if (water) skid = 0;
    const skidG = sealed ? T.skidVolume * Math.pow(skid, 1.3) : T.skidVolume * 0.35 * skid;
    const squealG = sealed ? T.squealVolume * Math.pow(clamp((skid - 0.25) / 0.75, 0, 1), 1.5) : 0;
    this.skidGain.gain.setTargetAtTime(skidG, t, 0.05);
    this.squealGain.gain.setTargetAtTime(squealG, t, 0.06);
    this.skidFilter.frequency.setTargetAtTime(sealed ? 900 + 600 * skid : 500, t, 0.08);
    this.squeal.detune.setTargetAtTime(skid * 120, t, 0.1);

    const spdN = clamp(speed / 50, 0, 1);
    const rollG = sealed ? T.rollVolume * Math.sqrt(spdN) * clamp(speed / 2, 0, 1) : 0;
    this.rollGain.gain.setTargetAtTime(rollG, t, 0.08);
    this.rollFilter.frequency.setTargetAtTime(250 + 450 * spdN, t, 0.1);

    const offG = !sealed && !water ? T.offroadVolume * (Math.sqrt(clamp(speed / 25, 0, 1)) + skid * 0.6) * clamp(speed / 1.5, 0, 1) : 0;
    this.offGain.gain.setTargetAtTime(Math.min(T.offroadVolume * 1.4, offG), t, 0.06);
    this.offFilter.frequency.setTargetAtTime(surf === 'sand' ? 800 : surf === 'gravel' ? 3000 : surf === 'rough' ? 2200 : 1600, t, 0.1);
    this.crackleSrc.playbackRate.setTargetAtTime(0.6 + clamp(speed / 20, 0, 1.2), t, 0.1);

    const windG = T.windVolume * spdN * spdN;
    this.windGain.gain.setTargetAtTime(windG, t, 0.2);

    // --- one-shots
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    const decayed = this.prevImpact * Math.exp(-dt * 6);
    if (car.impact > decayed + 0.02 && car.impact > 0.03 && this.impactCooldown === 0) {
      this.thump(car.impact, t);
      this.impactCooldown = 0.12;
    }
    this.prevImpact = car.impact;
    if (water && !this.wasInWater) this.splash(t);
    this.wasInWater = water;

    const s = this.state;
    s.rpm = this.rpm; s.gear = car.vF < -0.5 ? 'R' : this.gear;
    s.engineCutoff = cutoff; s.engineGain = eg; s.skidGain = skidG; s.squealGain = squealG;
    s.rollGain = rollG; s.offroadGain = offG; s.windGain = windG;
  }

  noiseBurst(t) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.whiteBuf;
    s.start(t, Math.random() * 1.5);
    return s;
  }

  thump(strength, t) {
    const ctx = this.ctx, A = TUNE.impactVolume * (0.25 + 0.75 * clamp(strength, 0, 1));
    // body: falling sine
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(115, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(A, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.01, 0.11);
    o.connect(g); g.connect(this.bus);
    o.start(t); o.stop(t + 0.8);
    // crunch: low-passed noise, brighter for harder hits
    const n = this.noiseBurst(t);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(600 + 1800 * strength, t);
    f.frequency.exponentialRampToValueAtTime(250, t + 0.2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(A * 0.7, t + 0.004);
    ng.gain.setTargetAtTime(0, t + 0.008, 0.05);
    n.connect(f); f.connect(ng); ng.connect(this.bus);
    n.stop(t + 0.5);
    this.state.impacts++;
    this.state.lastImpact = strength;
  }

  splash(t) {
    const ctx = this.ctx, A = TUNE.splashVolume;
    const n = this.noiseBurst(t);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.setValueAtTime(0.9, t);
    f.frequency.setValueAtTime(2600, t);
    f.frequency.exponentialRampToValueAtTime(450, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(A, t + 0.03);
    g.gain.setTargetAtTime(0, t + 0.12, 0.3);
    n.connect(f); f.connect(g); g.connect(this.bus);
    n.stop(t + 2);
    // low "whoomp"
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(A * 0.6, t + 0.015);
    og.gain.setTargetAtTime(0, t + 0.03, 0.14);
    o.connect(og); og.connect(this.bus);
    o.start(t); o.stop(t + 1);
    this.state.splashes++;
  }

  // peak absolute sample of the last analyser window (after the limiter)
  peak() {
    if (!this.analyser) return 0;
    const a = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(a);
    let m = 0; for (const v of a) m = Math.max(m, Math.abs(v));
    return m;
  }

  // live parameter values, read back from the audio graph
  debug() {
    if (!this.ctx) return { ...this.state };
    return {
      ...this.state,
      contextState: this.ctx.state,
      param: {
        master: this.master.gain.value,
        engineFreq: this.engOsc[0].frequency.value,
        engineCutoff: this.engFilter.frequency.value,
        skid: this.skidGain.gain.value,
        roll: this.rollGain.gain.value,
        offroad: this.offGain.gain.value,
      },
    };
  }
}
