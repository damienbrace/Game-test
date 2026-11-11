// Camera rig: smooth chase camera, and a high "overview" camera.
// Works in map space (x east, y north); world = (x, height, -y).

import * as THREE from 'three';

const MODES = [
  { name: 'Chase', dist: 6.8, height: 2.5, look: 1.1, ahead: 3, fov: 62, near: 0.4 },
  { name: 'High', dist: 26, height: 46, look: 0, ahead: 10, fov: 55, near: 1 },
];

// the chase camera keeps this far (m) from any building wall, so the near
// plane never cuts into one
const CLEAR = 0.75;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.mode = 0;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.first = true;
    this.distScale = 1;
    this.lift = 0;
  }

  get modeName() { return MODES[this.mode].name; }

  next() { this.mode = (this.mode + 1) % MODES.length; this.first = true; }

  snap() { this.first = true; }

  update(dt, car) {
    const M = MODES[this.mode];
    const chase = this.mode === 0;
    const x = car.renderX, y = car.renderY, h = car.renderHeading;
    const spd = car.speed;
    const yawRate = chase ? 5 : 2.5;
    if (this.first) { this.yaw = h; this.distScale = 1; this.lift = 0; }
    else this.yaw += wrap(h - this.yaw) * Math.min(1, dt * yawRate);
    const fx = Math.sin(this.yaw), fy = Math.cos(this.yaw);
    const extra = chase ? Math.min(2.2, spd * 0.05) : Math.min(14, spd * 0.35);
    let dist = M.dist + extra;
    // pull the chase camera in front of walls that would block the view
    if (chase && this.world) {
      const t = clearFraction(this.world, x, y, x - fx * dist, y - fy * dist, CLEAR);
      const want = Math.max(0.3, t);
      this.distScale += (want - this.distScale) * Math.min(1, dt * (want < this.distScale ? 14 : 2));
      dist *= this.distScale;
    }
    // when pulled in close, rise up and look down over the car instead
    const liftWant = chase ? (1 - this.distScale) * 3.4 : 0;
    this.lift += (liftWant - this.lift) * Math.min(1, dt * 6);
    const camX = x - fx * dist, camY = y - fy * dist;
    const camH = M.height + this.lift + (chase ? 0 : extra * 0.8);
    const desired = new THREE.Vector3(camX, camH, -camY);
    const look = new THREE.Vector3(x + fx * M.ahead, M.look, -(y + fy * M.ahead));
    if (this.first) { this.pos.copy(desired); this.target.copy(look); this.first = false; }
    else {
      this.pos.lerp(desired, Math.min(1, dt * (chase ? 9 : 4)));
      this.target.lerp(look, Math.min(1, dt * 12));
    }
    // the smoothed position can still lag into a wall (e.g. reversing or
    // spinning next to a building): constrain the actual camera too
    if (chase && this.world) constrain(this.world, x, y, this.pos);
    // small shake on impacts
    const sh = car.impact * 0.25;
    this.camera.position.set(this.pos.x + (Math.random() - 0.5) * sh, this.pos.y + (Math.random() - 0.5) * sh, this.pos.z);
    this.camera.lookAt(this.target);
    const fov = M.fov + (chase ? Math.min(12, spd * 0.22) : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05 || this.camera.near !== M.near) {
      this.camera.fov = fov;
      this.camera.near = M.near;
      this.camera.updateProjectionMatrix();
    }
  }
}

// Keep the camera (Vector3 in world coords) on the car's side of every wall
// and at least CLEAR from it. (ax, ay) is the car, which is never inside one.
function constrain(world, ax, ay, pos) {
  let bx = pos.x, by = -pos.z;
  const t = clearFraction(world, ax, ay, bx, by, CLEAR);
  if (t < 1) { bx = ax + (bx - ax) * t; by = ay + (by - ay) * t; }
  // push sideways off walls that run alongside the camera
  const G = world.CG;
  for (let iter = 0; iter < 2; iter++) {
    for (let gx = Math.floor((bx - CLEAR) / G); gx <= Math.floor((bx + CLEAR) / G); gx++)
      for (let gy = Math.floor((by - CLEAR) / G); gy <= Math.floor((by + CLEAR) / G); gy++) {
        const cell = world.colGrid.get(gx * 65536 + gy);
        if (!cell) continue;
        for (const s of cell.s) {
          const dx = s[2] - s[0], dy = s[3] - s[1];
          const l2 = dx * dx + dy * dy || 1e-9;
          let u = ((bx - s[0]) * dx + (by - s[1]) * dy) / l2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const nx = bx - (s[0] + dx * u), ny = by - (s[1] + dy * u);
          const d = Math.hypot(nx, ny);
          if (d >= CLEAR || d < 1e-6) continue;
          const nbx = bx + (nx / d) * (CLEAR - d), nby = by + (ny / d) * (CLEAR - d);
          // only accept the push if it does not take the camera through another wall
          if (clearFraction(world, ax, ay, nbx, nby, 0) === 1) { bx = nbx; by = nby; }
        }
      }
  }
  pos.x = bx; pos.z = -by;
}

// Fraction (0..1) of the segment a->b that can be travelled while staying at
// least `margin` short of the first building wall it crosses.
function clearFraction(world, ax, ay, bx, by, margin) {
  const G = world.CG;
  const rx = bx - ax, ry = by - ay;
  const len = Math.hypot(rx, ry);
  if (len < 1e-6) return 1;
  let best = Infinity;
  const gx0 = Math.floor(Math.min(ax, bx) / G), gx1 = Math.floor(Math.max(ax, bx) / G);
  const gy0 = Math.floor(Math.min(ay, by) / G), gy1 = Math.floor(Math.max(ay, by) / G);
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const cell = world.colGrid.get(gx * 65536 + gy);
    if (!cell) continue;
    for (const s of cell.s) {
      const sx = s[2] - s[0], sy = s[3] - s[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s[0] - ax) * sy - (s[1] - ay) * sx) / den;
      const u = ((s[0] - ax) * ry - (s[1] - ay) * rx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  if (best === Infinity) return 1;
  return Math.max(0, (best * len - margin) / len);
}
