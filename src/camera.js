// Camera rig: smooth chase camera, and a high "overview" camera.
// Works in map space (x east, y north); world = (x, height, -y).

import * as THREE from 'three';

const MODES = [
  { name: 'Chase', dist: 6.8, height: 2.5, look: 1.1, ahead: 3, fov: 62 },
  { name: 'High', dist: 26, height: 46, look: 0, ahead: 10, fov: 55 },
];

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
  }

  get modeName() { return MODES[this.mode].name; }

  next() { this.mode = (this.mode + 1) % MODES.length; this.first = true; }

  snap() { this.first = true; }

  update(dt, car) {
    const M = MODES[this.mode];
    const x = car.renderX, y = car.renderY, h = car.renderHeading;
    const spd = car.speed;
    // follow heading; when reversing slowly keep looking forward
    const yawRate = this.mode === 0 ? 5 : 2.5;
    if (this.first) this.yaw = h;
    else this.yaw += wrap(h - this.yaw) * Math.min(1, dt * yawRate);
    const fx = Math.sin(this.yaw), fy = Math.cos(this.yaw);
    const extra = this.mode === 0 ? Math.min(2.2, spd * 0.05) : Math.min(14, spd * 0.35);
    let dist = M.dist + extra;
    // pull the chase camera in front of buildings that would block the view
    if (this.mode === 0) {
      const t = this.world ? blockedFraction(this.world, x, y, x - fx * dist, y - fy * dist) : 1;
      const want = Math.max(0.35, t);
      this.distScale += (want - this.distScale) * Math.min(1, dt * (want < this.distScale ? 12 : 2));
      dist *= this.distScale;
    }
    const camX = x - fx * dist, camY = y - fy * dist;
    const camH = M.height + (this.mode === 1 ? extra * 0.8 : 0);
    const desired = new THREE.Vector3(camX, camH, -camY);
    const look = new THREE.Vector3(x + fx * M.ahead, M.look, -(y + fy * M.ahead));
    if (this.first) { this.pos.copy(desired); this.target.copy(look); this.first = false; }
    else {
      this.pos.lerp(desired, Math.min(1, dt * (this.mode === 0 ? 9 : 4)));
      this.target.lerp(look, Math.min(1, dt * 12));
    }
    // small shake on impacts
    const sh = car.impact * 0.25;
    this.camera.position.set(this.pos.x + (Math.random() - 0.5) * sh, this.pos.y + (Math.random() - 0.5) * sh, this.pos.z);
    this.camera.lookAt(this.target);
    const fov = M.fov + (this.mode === 0 ? Math.min(12, spd * 0.22) : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}

// fraction (0..1) of the segment car->camera that is clear of building walls
function blockedFraction(world, ax, ay, bx, by) {
  const G = world.CG;
  let best = 1;
  const gx0 = Math.floor(Math.min(ax, bx) / G), gx1 = Math.floor(Math.max(ax, bx) / G);
  const gy0 = Math.floor(Math.min(ay, by) / G), gy1 = Math.floor(Math.max(ay, by) / G);
  const rx = bx - ax, ry = by - ay;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const cell = world.colGrid.get(gx * 65536 + gy);
    if (!cell) continue;
    for (const s of cell.s) {
      const sx = s[2] - s[0], sy = s[3] - s[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s[0] - ax) * sy - (s[1] - ay) * sx) / den;
      const u = ((s[0] - ax) * ry - (s[1] - ay) * rx) / den;
      if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
    }
  }
  return best < 1 ? best * 0.85 : 1;
}
