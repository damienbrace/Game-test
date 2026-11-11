// Player car: an original low-poly model built from primitives, plus an
// arcade driving model. Physics runs in map space (x = east, y = north) with
// `heading` as a compass bearing in radians (0 = north, clockwise positive),
// so forward = (sin h, cos h) and right = (cos h, -sin h).

import * as THREE from 'three';
import { pointInRing } from './world.js';

const WHEELBASE = 2.7;
const WHEEL_R = 0.36;
// collision: three circles along the car's long axis
const COL_R = 0.93;
const COL_OFFS = [1.3, 0, -1.3];

// per-surface handling: grip multiplier, rolling drag (m/s^2), top-speed and
// acceleration multipliers
const SURF = {
  road: { grip: 1, drag: 0.25, vmax: 1, acc: 1 },
  paved: { grip: 0.95, drag: 0.35, vmax: 1, acc: 1 },
  gravel: { grip: 0.7, drag: 0.6, vmax: 0.7, acc: 0.85 },  // ~95 km/h flat out
  grass: { grip: 0.7, drag: 1.4, vmax: 0.5, acc: 0.7 },    // ~60 km/h
  rough: { grip: 0.6, drag: 2.0, vmax: 0.42, acc: 0.6 },   // ~45 km/h
  sand: { grip: 0.5, drag: 2.3, vmax: 0.38, acc: 0.55 },   // ~40 km/h
  water: { grip: 0.2, drag: 14, vmax: 0.1, acc: 0.1 },
};

// longitudinal tuning (m/s, m/s^2). Roughly 0-60 km/h in 3 s, 0-100 in 6 s,
// ~135 km/h flat out on the road: lively, but still drivable on suburban streets.
const TOP_SPEED = 40;
const ACCEL = 7.4;       // drive acceleration at standstill (tapers to 0 at TOP_SPEED)
const BRAKE = 14;        // service brake
const REV_ACC = 5;       // reverse
const REV_MAX = 8.5;     // ~30 km/h
const COAST = 1.1;       // engine braking with no pedal
// lateral grip (m/s^2 of cornering before the yaw rate is capped)
const LAT_GRIP = 12.5, LAT_GRIP_HB = 19;
// wall / tree contact
const WALL_FRICTION = 0.25;  // tangential speed lost per unit of impact speed
const BOUNCE = 0.15, BOUNCE_MAX = 2.2, BOUNCE_MIN = 2; // m/s; resting contact never bounces
const ALIGN_RATE = 7;        // 1/s: how quickly a glancing hit turns the car along the wall

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Car {
  constructor(world) {
    this.world = world;
    this.x = 0; this.y = 0; this.heading = 0;
    this.vx = 0; this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;     // front wheel angle (rad)
    this.steerIn = 0;   // smoothed steering input (-1..1)
    this.hbAmt = 0;     // smoothed handbrake (0..1), so drifts blend in and out
    this.contactT = 0;  // > 0 for a moment after touching a wall or tree
    this.deflect = 0;   // extra yaw rate (rad/s) from glancing off a wall
    this.vF = 0; this.vL = 0;
    this.surface = 'road';
    this.waterTime = 0;
    this.prev = { x: 0, y: 0, heading: 0 };
    this.lastSafe = null;
    this.safeTimer = 0;
    this.impact = 0;
    this.wheelSpin = 0;
    this.roll = 0; this.pitch = 0;
    this.accelLong = 0;
    this.onReset = null;
    this.buildMesh();
  }

  // ------------------------------------------------------------ model
  buildMesh() {
    const paint = new THREE.MeshLambertMaterial({ color: 0xe8692c });
    const stripe = new THREE.MeshLambertMaterial({ color: 0xf4efe2 });
    const glass = new THREE.MeshLambertMaterial({ color: 0x24313b });
    const dark = new THREE.MeshLambertMaterial({ color: 0x26272b });
    const tyre = new THREE.MeshLambertMaterial({ color: 0x1b1b1d });
    const rimM = new THREE.MeshLambertMaterial({ color: 0xc9ccd1 });
    const head = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
    const tail = new THREE.MeshBasicMaterial({ color: 0xd8261c });

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const box = (w, h, d, m, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      body.add(mesh);
      return mesh;
    };
    // lower body with a slightly tapered nose
    const lowerG = new THREE.BoxGeometry(1.84, 0.56, 4.2);
    const lp = lowerG.attributes.position;
    for (let i = 0; i < lp.count; i++) {
      if (lp.getZ(i) > 0 && lp.getY(i) > 0) lp.setY(i, lp.getY(i) - 0.12); // sloped bonnet
      if (lp.getZ(i) > 0) lp.setX(i, lp.getX(i) * 0.96);
    }
    lowerG.computeVertexNormals();
    const lower = new THREE.Mesh(lowerG, paint);
    lower.position.set(0, 0.62, 0);
    body.add(lower);
    // cabin: tapered box (glass), with a painted roof panel
    const cabG = new THREE.BoxGeometry(1.64, 0.56, 2.2);
    const cp = cabG.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      if (cp.getY(i) > 0) { cp.setX(i, cp.getX(i) * 0.8); cp.setZ(i, cp.getZ(i) * 0.62 - 0.12); }
    }
    cabG.computeVertexNormals();
    const cab = new THREE.Mesh(cabG, glass);
    cab.position.set(0, 1.17, -0.25);
    body.add(cab);
    box(1.3, 0.07, 1.36, paint, 0, 1.47, -0.37);
    box(0.34, 0.075, 1.38, stripe, 0, 1.49, -0.37);
    box(0.34, 0.02, 1.7, stripe, 0, 0.84, 1.15).rotation.x = 0.07;
    // bumpers, lights, spoiler
    box(1.9, 0.26, 0.28, dark, 0, 0.42, 2.12);
    box(1.9, 0.26, 0.28, dark, 0, 0.42, -2.12);
    box(0.42, 0.14, 0.06, head, 0.58, 0.72, 2.08);
    box(0.42, 0.14, 0.06, head, -0.58, 0.72, 2.08);
    box(0.46, 0.14, 0.06, tail, 0.6, 0.78, -2.11);
    box(0.46, 0.14, 0.06, tail, -0.6, 0.78, -2.11);
    box(1.7, 0.06, 0.34, dark, 0, 1.12, -1.98);
    box(0.08, 0.22, 0.12, dark, 0.7, 1.0, -1.98);
    box(0.08, 0.22, 0.12, dark, -0.7, 1.0, -1.98);

    // wheels: pivot (steer) -> spinner (roll) -> tyre + rim + spoke
    this.wheels = [];
    const tyreG = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.26, 14);
    tyreG.rotateZ(Math.PI / 2);
    const rimG = new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, 0.27, 10);
    rimG.rotateZ(Math.PI / 2);
    const spokeG = new THREE.BoxGeometry(0.28, 0.1, WHEEL_R * 1.25);
    for (const [x, z, front] of [[0.84, 1.35, true], [-0.84, 1.35, true], [0.84, -1.35, false], [-0.84, -1.35, false]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_R, z);
      const spin = new THREE.Group();
      pivot.add(spin);
      spin.add(new THREE.Mesh(tyreG, tyre));
      spin.add(new THREE.Mesh(rimG, rimM));
      spin.add(new THREE.Mesh(spokeG, dark));
      root.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }
    this.mesh = root;
    this.body = body;

    // soft blob shadow on the ground
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 5.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.02;
    const shadowRoot = new THREE.Group();
    shadowRoot.add(sh);
    this.shadow = shadowRoot;
  }

  // ------------------------------------------------------------ state
  place(x, y, heading) {
    this.x = x; this.y = y; this.heading = heading;
    this.vx = this.vy = 0; this.yawRate = 0; this.steer = this.steerIn = 0; this.vF = this.vL = 0;
    this.hbAmt = 0; this.contactT = 0; this.deflect = 0; this.impact = 0;
    this.waterTime = 0;
    this.prev = { x, y, heading };
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  // put the car back on the nearest road, aligned with it
  resetToRoad() {
    const w = this.world;
    let near = w.nearestRoad(this.x, this.y, 250, (r) => r.c < 8);
    let x, y, dx, dy;
    if (near) { x = near.px; y = near.py; dx = near.dx; dy = near.dy; }
    else if (this.lastSafe) { x = this.lastSafe.x; y = this.lastSafe.y; dx = Math.sin(this.lastSafe.heading); dy = Math.cos(this.lastSafe.heading); }
    else { const s = w.data.spawn; x = s.x; y = s.y; dx = s.dx; dy = s.dy; }
    // keep the direction closest to the current heading
    const fx = Math.sin(this.heading), fy = Math.cos(this.heading);
    if (dx * fx + dy * fy < 0) { dx = -dx; dy = -dy; }
    this.place(x, y, Math.atan2(dx, dy));
    if (this.onReset) this.onReset();
  }

  // ------------------------------------------------------------ physics
  step(dt, input) {
    this.prev.x = this.x; this.prev.y = this.y; this.prev.heading = this.heading;
    const surfName = this.world.surfaceAt(this.x, this.y);
    this.surface = surfName;
    const S = SURF[surfName] || SURF.grass;

    const thr = clamp(input.throttle || 0, 0, 1), brk = clamp(input.brake || 0, 0, 1);
    this.hbAmt += ((input.handbrake ? 1 : 0) - this.hbAmt) * Math.min(1, dt * (input.handbrake ? 10 : 5));
    const hb = this.hbAmt;
    const touching = this.contactT > 0;

    // 1. steering. The input is smoothed (so keyboard taps ramp in over ~0.2 s
    // at any speed), then scaled by a speed-sensitive full-lock angle chosen so
    // that full lock is just past the grip limit: analog input stays
    // proportional all the way across the stick instead of saturating early.
    let fx = Math.sin(this.heading), fy = Math.cos(this.heading);
    let vF = this.vx * fx + this.vy * fy;
    const spd = Math.abs(vF);
    const sIn = clamp(input.steer || 0, -1, 1);
    const back = Math.abs(sIn) < Math.abs(this.steerIn) || Math.sign(sIn) !== Math.sign(this.steerIn);
    const sRate = (back ? 9 : 5.5) * dt;
    this.steerIn += clamp(sIn - this.steerIn, -sRate, sRate);
    const maxLat = (LAT_GRIP + (LAT_GRIP_HB - LAT_GRIP) * hb) * (0.5 + 0.5 * S.grip);
    const lim = maxLat / Math.max(2, spd);
    const steerMax = Math.min(0.56, Math.atan((lim * 1.15 * WHEELBASE) / Math.max(0.5, spd)));
    this.steer = this.steerIn * steerMax;

    // 2. yaw: kinematic bicycle model, capped by available lateral grip.
    // Pressed against a wall at a standstill, throttle still lets the car
    // pivot (as if scrubbing its tyres), so it can always steer free.
    let vYaw = vF;
    if (touching && spd < 3) {
      const push = thr > brk ? thr : -brk;
      if (Math.abs(push) * 3 > Math.abs(vYaw)) vYaw = push * 3;
    }
    let yawTarget = (vYaw * Math.tan(this.steer)) / WHEELBASE;
    yawTarget = clamp(yawTarget, -lim, lim);
    if (spd > 4) yawTarget *= 1 + 0.45 * hb;
    const yawResp = (9 - 5.5 * hb) * (0.4 + 0.6 * S.grip);
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * yawResp);
    this.heading += (this.yawRate + this.deflect) * dt;
    this.deflect *= Math.exp(-dt * 8);
    if (Math.abs(this.deflect) < 1e-3) this.deflect = 0;

    // 3. decompose velocity in the new frame (this is what lets the car slide)
    fx = Math.sin(this.heading); fy = Math.cos(this.heading);
    const rx = fy, ry = -fx;
    vF = this.vx * fx + this.vy * fy;
    let vL = this.vx * rx + this.vy * ry;

    // 4. longitudinal forces
    const vmax = TOP_SPEED * S.vmax;
    let drive = 0, resist = S.drag + 0.0011 * vF * vF;
    if (thr > 0) {
      if (vF < -0.5) resist += 16 * thr; // throttle while rolling back acts as a brake
      else drive += ACCEL * thr * S.acc * Math.max(0, 1 - Math.pow(Math.max(0, vF) / vmax, 2));
    }
    if (brk > 0) {
      if (vF > 0.5) resist += BRAKE * brk;
      else if (vF > -REV_MAX * Math.max(0.5, S.vmax)) drive -= REV_ACC * brk * S.acc;
    }
    if (thr === 0 && brk === 0) resist += COAST;
    if (input.handbrake) resist += 4.5;
    // above the surface's top speed (e.g. leaving the road at speed): bleed off
    // firmly, but not like hitting a wall
    if (Math.abs(vF) > vmax * 1.05) resist += (Math.abs(vF) - vmax) * 1.2;
    const before = vF;
    vF += drive * dt;
    const dec = resist * dt;
    if (Math.abs(vF) <= dec && (drive === 0 || Math.sign(drive) !== Math.sign(vF))) vF = 0;
    else vF -= Math.sign(vF) * dec;
    this.accelLong = (vF - before) / dt;

    // 5. lateral grip (lower with handbrake / loose surfaces -> drift). While
    // scraping a wall the tyres give way, so the car slides along it instead
    // of gripping against it.
    let latGrip = (8.5 - 7 * hb) * S.grip;
    if (touching) latGrip *= 0.3;
    vL *= Math.exp(-latGrip * dt);

    this.vx = fx * vF + rx * vL;
    this.vy = fy * vF + ry * vL;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.contactT = Math.max(0, this.contactT - dt);
    this.collide(dt);
    this.clampBounds();
    // report the post-collision velocity
    this.vF = this.vx * fx + this.vy * fy;
    this.vL = this.vx * rx + this.vy * ry;
    vF = this.vF;

    // water: car bogs down and is reset to the last safe spot
    if (surfName === 'water') {
      this.waterTime += dt;
      if (this.waterTime > 1.3) {
        if (this.lastSafe) { this.place(this.lastSafe.x, this.lastSafe.y, this.lastSafe.heading); if (this.onReset) this.onReset(); }
        else this.resetToRoad();
      }
    } else this.waterTime = Math.max(0, this.waterTime - dt * 2);

    this.safeTimer += dt;
    if (this.safeTimer > 0.5 && (surfName === 'road' || surfName === 'paved')) {
      this.safeTimer = 0;
      this.lastSafe = { x: this.x - fx * 3, y: this.y - fy * 3, heading: this.heading };
      // never remember a spot that is itself blocked
      if (this.world.surfaceAt(this.lastSafe.x, this.lastSafe.y) === 'water') this.lastSafe = { x: this.x, y: this.y, heading: this.heading };
    }

    this.wheelSpin += (vF / WHEEL_R) * dt;
    // visual body motion
    const latAcc = this.yawRate * vF;
    this.roll += (clamp(-latAcc * 0.006, -0.07, 0.07) - this.roll) * Math.min(1, dt * 8);
    this.pitch += (clamp(-this.accelLong * 0.004, -0.05, 0.05) - this.pitch) * Math.min(1, dt * 6);
    this.impact *= Math.exp(-dt * 6);
  }

  // Push the three collision circles out of building walls and trees, then
  // resolve velocity: the part into the obstacle is removed (with a small
  // bounce only for real hits, so resting contact never jitters), and the part
  // along it is kept minus a loss proportional to the impact speed (glancing
  // hits cost little, square hits stop the car). A glancing hit also turns the
  // car along the wall, so the tyres do not keep driving it back in.
  collide(dt) {
    let best = null; // strongest contact this step
    for (let iter = 0; iter < 3; iter++) {
      let hit = false;
      const fx = Math.sin(this.heading), fy = Math.cos(this.heading);
      for (const off of COL_OFFS) {
        const p = this.pushOut(this.x + fx * off, this.y + fy * off, COL_R);
        if (!p) continue;
        hit = true;
        this.x += p[0]; this.y += p[1];
        const pl = Math.hypot(p[0], p[1]);
        const nx = p[0] / pl, ny = p[1] / pl;
        const vn = this.vx * nx + this.vy * ny;
        if (!best) best = { nx, ny, imp: 0, tree: p[2] };
        if (vn >= 0) continue;
        const imp = -vn;
        const tx = -ny, ty = nx;
        let vt = this.vx * tx + this.vy * ty;
        vt -= Math.sign(vt) * Math.min(Math.abs(vt), imp * WALL_FRICTION);
        const bounce = Math.min(BOUNCE_MAX, Math.max(0, imp - BOUNCE_MIN) * BOUNCE);
        this.vx = tx * vt + nx * bounce;
        this.vy = ty * vt + ny * bounce;
        if (imp >= best.imp) best = { nx, ny, imp, tree: p[2] };
        this.yawRate *= 1 - Math.min(0.6, imp * 0.06);
        this.impact = Math.max(this.impact, Math.min(1, imp / 15));
      }
      if (!hit) break;
    }
    if (!best) return;
    this.contactT = 0.15;

    // turn the direction of travel along the wall
    const fx = Math.sin(this.heading), fy = Math.cos(this.heading);
    const vF = this.vx * fx + this.vy * fy;
    const tx = -best.ny, ty = best.nx;
    const vt = this.vx * tx + this.vy * ty;
    if (Math.abs(vt) < 0.4 || Math.abs(vF) < 0.4) return;
    const dirSign = Math.sign(vF); // travelling nose-first or tail-first
    if ((fx * best.nx + fy * best.ny) * dirSign >= 0) return; // already pointing away
    const st = Math.sign(vt);
    let target = Math.atan2(tx * st, ty * st);
    if (dirSign < 0) target += Math.PI;
    const diff = wrap(target - this.heading);
    const deg = (Math.abs(diff) * 180) / Math.PI;
    // full strength up to 50 deg into the wall, none past 80 (head-on: just stop)
    // a tree is a point, so only nudge the car round it rather than lining it up
    const w = clamp((80 - deg) / 30, 0, 1) * (best.tree ? 0.4 : 1);
    if (w <= 0) return;
    const want = diff * ALIGN_RATE * w;
    if (Math.sign(want) !== Math.sign(this.deflect) || Math.abs(want) > Math.abs(this.deflect)) this.deflect = want;
    // don't let the steering model fight the deflection
    if (Math.sign(this.yawRate) !== Math.sign(diff)) this.yawRate *= Math.exp(-dt * 20);
  }

  // total push (dx, dy) that moves a circle at (cx, cy) out of walls, building
  // footprints and trees ([dx, dy, touchedTree]), or null if it touches nothing
  pushOut(cx, cy, r) {
    const w = this.world;
    const G = w.CG;
    let pushX = 0, pushY = 0, tree = false;
    const gx0 = Math.floor((cx - r) / G), gx1 = Math.floor((cx + r) / G);
    const gy0 = Math.floor((cy - r) / G), gy1 = Math.floor((cy + r) / G);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const cell = w.colGrid.get(gx * 65536 + gy);
      if (!cell) continue;
      // deep penetration recovery: centre inside a footprint
      for (const poly of cell.p) {
        const bb = poly.bb;
        if (cx < bb[0] || cx > bb[2] || cy < bb[1] || cy > bb[3]) continue;
        if (!pointInRing(cx, cy, poly.p)) continue;
        const q = nearestOnRing(cx, cy, poly.p);
        const dx = q[0] - cx, dy = q[1] - cy, d = Math.hypot(dx, dy) || 1e-6;
        pushX += (dx / d) * (d + r); pushY += (dy / d) * (d + r);
        cx += (dx / d) * (d + r); cy += (dy / d) * (d + r);
      }
      for (const s of cell.s) {
        const dx = s[2] - s[0], dy = s[3] - s[1];
        const l2 = dx * dx + dy * dy || 1e-9;
        let t = ((cx - s[0]) * dx + (cy - s[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s[0] + dx * t, qy = s[1] + dy * t;
        let nx = cx - qx, ny = cy - qy;
        const d = Math.hypot(nx, ny);
        if (d >= r) continue;
        if (d < 1e-6) { nx = dy; ny = -dx; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; } else { nx /= d; ny /= d; }
        const pen = r - d;
        pushX += nx * pen; pushY += ny * pen;
        cx += nx * pen; cy += ny * pen;
      }
      for (const c of cell.c) {
        let nx = cx - c[0], ny = cy - c[1];
        const d = Math.hypot(nx, ny), rr = r + c[2];
        if (d >= rr) continue;
        if (d < 1e-6) { nx = 1; ny = 0; } else { nx /= d; ny /= d; }
        const pen = rr - d;
        pushX += nx * pen; pushY += ny * pen;
        cx += nx * pen; cy += ny * pen;
        tree = true;
      }
    }
    return Math.hypot(pushX, pushY) > 1e-5 ? [pushX, pushY, tree] : null;
  }

  clampBounds() {
    const [x0, y0, x1, y1] = this.world.bounds;
    const m = 5;
    if (this.x < x0 + m) { this.x = x0 + m; if (this.vx < 0) this.vx = 0; }
    if (this.x > x1 - m) { this.x = x1 - m; if (this.vx > 0) this.vx = 0; }
    if (this.y < y0 + m) { this.y = y0 + m; if (this.vy < 0) this.vy = 0; }
    if (this.y > y1 - m) { this.y = y1 - m; if (this.vy > 0) this.vy = 0; }
  }

  // ------------------------------------------------------------ render sync
  sync(alpha) {
    const x = this.prev.x + (this.x - this.prev.x) * alpha;
    const y = this.prev.y + (this.y - this.prev.y) * alpha;
    let dh = this.heading - this.prev.heading;
    const h = this.prev.heading + dh * alpha;
    this.renderX = x; this.renderY = y; this.renderHeading = h;
    const sink = Math.min(0.7, this.waterTime * 0.6);
    this.mesh.position.set(x, -sink, -y);
    this.mesh.rotation.y = Math.PI - h; // model faces +z; map heading 0 = -z (north)
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;
    for (const wh of this.wheels) {
      wh.spin.rotation.x = this.wheelSpin;
      if (wh.front) wh.pivot.rotation.y = -this.steer;
    }
    this.shadow.position.set(x, 0, -y);
    this.shadow.rotation.y = Math.PI - h;
    this.shadow.visible = sink < 0.2;
  }
}

function nearestOnRing(x, y, r) {
  let best = null, bd = Infinity;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, py = ay + dy * t;
    const d = (x - px) ** 2 + (y - py) ** 2;
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best;
}
