// Input: keyboard, gamepad (Gamepad API, standard mapping) and on-screen
// touch controls. All three are read every frame and combined:
//   steer    -1..1 (right positive)   sum of sources, clamped
//   throttle  0..1                     max of sources
//   brake     0..1 (brake / reverse)   max of sources
//   handbrake bool                     any source
//   reset / camera                     one-shot "pressed this frame" events

const DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;

// Standard-mapping indices (https://w3c.github.io/gamepad/#remapping)
const PAD = {
  steerAxis: 0,     // left stick X
  throttle: 7,      // right trigger (analog .value)
  brake: 6,         // left trigger (analog .value)
  handbrake: 0,     // A / Cross
  reset: 1,         // B / Circle
  camera: 3,        // Y / Triangle
  dpadLeft: 14,
  dpadRight: 15,
};

function stickDeadzone(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.events = { reset: false, camera: false };
    this.padPrev = {};
    this.padName = null;
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, camera: false };
    this.lastSource = 'keyboard';

    const gameKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    addEventListener('keydown', (e) => {
      if (gameKeys.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastSource = 'keyboard';
      if (e.code === 'KeyR') this.events.reset = true;
      if (e.code === 'KeyC') this.events.camera = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => { this.padName = e.gamepad.id; });
    addEventListener('gamepaddisconnected', () => { this.padName = null; });
  }

  readGamepad() {
    const out = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, camera: false, active: false };
    if (!navigator.getGamepads) return out;
    let pad = null;
    for (const p of navigator.getGamepads()) {
      if (p && p.connected) { pad = p; if (p.mapping === 'standard') break; }
    }
    if (!pad) return out;
    const b = (i) => pad.buttons[i] || { pressed: false, value: 0 };
    const val = (i) => { const v = b(i).value || (b(i).pressed ? 1 : 0); return v < TRIGGER_DEADZONE ? 0 : v; };
    out.steer = stickDeadzone(pad.axes[PAD.steerAxis] || 0);
    if (b(PAD.dpadLeft).pressed) out.steer = -1;
    if (b(PAD.dpadRight).pressed) out.steer = 1;
    out.throttle = val(PAD.throttle);
    out.brake = val(PAD.brake);
    out.handbrake = b(PAD.handbrake).pressed;
    // edge-triggered buttons
    for (const name of ['reset', 'camera']) {
      const now = b(PAD[name]).pressed;
      if (now && !this.padPrev[name]) out[name] = true;
      this.padPrev[name] = now;
    }
    out.active = out.steer !== 0 || out.throttle > 0 || out.brake > 0 || out.handbrake;
    return out;
  }

  update() {
    const k = this.keys;
    const kb = {
      steer: (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      throttle: k.has('KeyW') || k.has('ArrowUp') ? 1 : 0,
      brake: k.has('KeyS') || k.has('ArrowDown') ? 1 : 0,
      handbrake: k.has('Space'),
    };
    const gp = this.readGamepad();
    if (gp.active) this.lastSource = 'gamepad';
    const t = this.touch;
    const s = this.state;
    s.steer = Math.max(-1, Math.min(1, kb.steer + gp.steer + t.steer));
    s.throttle = Math.max(kb.throttle, gp.throttle, t.throttle);
    s.brake = Math.max(kb.brake, gp.brake, t.brake);
    s.handbrake = kb.handbrake || gp.handbrake || t.handbrake;
    s.reset = this.events.reset || gp.reset;
    s.camera = this.events.camera || gp.camera;
    this.events.reset = this.events.camera = false;
    return s;
  }

  // ------------------------------------------------------------ touch UI
  attachTouch(root) {
    root.classList.add('touch');
    const pad = root.querySelector('#steer-zone');
    const knob = root.querySelector('#steer-knob');
    const base = root.querySelector('#steer-base');
    let steerId = null, originX = 0, originY = 0;
    const RANGE = 55; // px for full lock
    const setKnob = (dx) => { knob.style.transform = `translate(${dx}px, 0)`; };
    pad.addEventListener('pointerdown', (e) => {
      if (steerId !== null) return;
      steerId = e.pointerId;
      try { pad.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers */ }
      const r = pad.getBoundingClientRect();
      originX = e.clientX; originY = e.clientY;
      base.style.left = `${e.clientX - r.left}px`;
      base.style.top = `${e.clientY - r.top}px`;
      base.classList.add('active');
      this.lastSource = 'touch';
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== steerId) return;
      const dx = Math.max(-RANGE, Math.min(RANGE, e.clientX - originX));
      this.touch.steer = dx / RANGE;
      setKnob(dx);
    });
    const endSteer = (e) => {
      if (e.pointerId !== steerId) return;
      steerId = null;
      this.touch.steer = 0;
      setKnob(0);
      base.classList.remove('active');
    };
    pad.addEventListener('pointerup', endSteer);
    pad.addEventListener('pointercancel', endSteer);

    const hold = (id, on, off) => {
      const el = root.querySelector(id);
      const ids = new Set();
      el.addEventListener('pointerdown', (e) => { ids.add(e.pointerId); try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers */ } el.classList.add('down'); on(); this.lastSource = 'touch'; e.preventDefault(); });
      const up = (e) => { if (!ids.delete(e.pointerId)) return; if (!ids.size) { el.classList.remove('down'); off(); } };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('#btn-gas', () => (this.touch.throttle = 1), () => (this.touch.throttle = 0));
    hold('#btn-brake', () => (this.touch.brake = 1), () => (this.touch.brake = 0));
    hold('#btn-hand', () => (this.touch.handbrake = true), () => (this.touch.handbrake = false));
  }

  // reset / camera buttons in the HUD work with mouse and touch alike
  attachButtons(root) {
    const tap = (id, fn) => root.querySelector(id).addEventListener('pointerdown', (e) => { fn(); e.preventDefault(); e.stopPropagation(); });
    tap('#btn-reset', () => (this.events.reset = true));
    tap('#btn-cam', () => (this.events.camera = true));
  }
}
