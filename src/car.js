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
  gravel: { grip: 0.7, drag: 0.9, vmax: 0.7, acc: 0.85 },
  grass: { grip: 0.7, drag: 2.2, vmax: 0.5, acc: 0.7 },
  rough: { grip: 0.6, drag: 3.0, vmax: 0.42, acc: 0.6 },
  sand: { grip: 0.5, drag: 3.6, vmax: 0.38, acc: 0.55 },
  water: { grip: 0.2, drag: 14, vmax: 0.1, acc: 0.1 },
};

const TOP_SPEED = 50; // m/s (180 km/h)

export class Car {
  constructor(world) {
    this.world = world;
    this.x = 0; this.y = 0; this.heading = 0;
    this.vx = 0; this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
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
    this.vx = this.vy = 0; this.yawRate = 0; this.steer = 0; this.vF = this.vL = 0;
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

    const hb = input.handbrake;
    // 1. steering: speed-sensitive maximum wheel angle, smoothed
    let fx = Math.sin(this.heading), fy = Math.cos(this.heading);
    let vF = this.vx * fx + this.vy * fy;
    const spd = Math.abs(vF);
    const steerMax = 0.62 / (1 + spd / 11);
    const target = input.steer * steerMax;
    const rate = Math.abs(target) < Math.abs(this.steer) || Math.sign(target) !== Math.sign(this.steer) ? 6 : 3.2;
    const ds = target - this.steer;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, ds));

    // 2. yaw: kinematic bicycle model, capped by available lateral grip
    let yawTarget = (vF * Math.tan(this.steer)) / WHEELBASE;
    const maxLat = (hb ? 19 : 12.5) * (0.5 + 0.5 * S.grip);
    const lim = maxLat / Math.max(2, spd);
    yawTarget = Math.max(-lim, Math.min(lim, yawTarget));
    if (hb && spd > 4) yawTarget *= 1.45;
    const yawResp = (hb ? 3.5 : 9) * (0.4 + 0.6 * S.grip);
    this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * yawResp);
    this.heading += this.yawRate * dt;

    // 3. decompose velocity in the new frame (this is what lets the car slide)
    fx = Math.sin(this.heading); fy = Math.cos(this.heading);
    const rx = fy, ry = -fx;
    vF = this.vx * fx + this.vy * fy;
    let vL = this.vx * rx + this.vy * ry;

    // 4. longitudinal forces
    const thr = input.throttle, brk = input.brake;
    const vmax = TOP_SPEED * S.vmax;
    let drive = 0, resist = S.drag + 0.0011 * vF * vF;
    if (thr > 0) {
      if (vF < -0.5) resist += 16 * thr;
      else drive += 11.5 * thr * S.acc * Math.max(0, 1 - Math.pow(Math.max(0, vF) / vmax, 2));
    }
    if (brk > 0) {
      if (vF > 0.5) resist += 17 * brk;
      else if (vF > -13 * Math.max(0.5, S.vmax)) drive -= 7 * brk * S.acc;
    }
    if (thr === 0 && brk === 0) resist += 1.1; // engine braking
    if (hb) resist += 5.5;
    if (vF > vmax * 1.05) resist += (vF - vmax) * 2; // e.g. driving off road at speed
    const before = vF;
    vF += drive * dt;
    const dec = resist * dt;
    if (Math.abs(vF) <= dec && (drive === 0 || Math.sign(drive) !== Math.sign(vF))) vF = 0;
    else vF -= Math.sign(vF) * dec;
    this.accelLong = (vF - before) / dt;

    // 5. lateral grip (lower with handbrake / loose surfaces -> drift)
    const latGrip = (hb ? 1.5 : 8.5) * S.grip;
    vL *= Math.exp(-latGrip * dt);

    this.vx = fx * vF + rx * vL;
    this.vy = fy * vF + ry * vL;
    this.vF = vF; this.vL = vL;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.collide();
    this.clampBounds();

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
    this.roll += (Math.max(-0.07, Math.min(0.07, -latAcc * 0.006)) - this.roll) * Math.min(1, dt * 8);
    this.pitch += (Math.max(-0.05, Math.min(0.05, -this.accelLong * 0.004)) - this.pitch) * Math.min(1, dt * 6);
    this.impact *= Math.exp(-dt * 6);
  }

  collide() {
    const w = this.world;
    const G = w.CG;
    for (let iter = 0; iter < 2; iter++) {
      let hit = false;
      const fx = Math.sin(this.heading), fy = Math.cos(this.heading);
      for (const off of COL_OFFS) {
        let cx = this.x + fx * off, cy = this.y + fy * off;
        const r = COL_R;
        let pushX = 0, pushY = 0;
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
          }
        }
        const pl = Math.hypot(pushX, pushY);
        if (pl > 1e-5) {
          hit = true;
          this.x += pushX; this.y += pushY;
          const nx = pushX / pl, ny = pushY / pl;
          const vn = this.vx * nx + this.vy * ny;
          if (vn < 0) {
            // remove the velocity into the wall (+ a little bounce)
            this.vx -= nx * vn * 1.15;
            this.vy -= ny * vn * 1.15;
            // wall friction proportional to the impact, so grazing or
            // resting against a wall never glues the car to it
            const tx = -ny, ty = nx;
            const vt = this.vx * tx + this.vy * ty;
            const f = Math.min(Math.abs(vt), -vn * 0.35) * Math.sign(vt);
            this.vx -= tx * f; this.vy -= ty * f;
            this.yawRate *= 1 - Math.min(0.5, -vn * 0.08);
            this.impact = Math.max(this.impact, Math.min(1, -vn / 15));
          }
        }
      }
      if (!hit) break;
    }
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
