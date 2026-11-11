// Stylised low-poly buildings from OSM footprints.
//
// Every footprint is turned into one of a few archetypes (house, shop /
// main-street terrace, apartments, civic, industrial shed, small shed,
// canopy, tank / silo) chosen from its kind, size, height tag and whether it
// sits in the CBD. All randomness is seeded from the footprint position, so
// the town is identical on every load.
//
// Facades are cheap: a wall is one quad per floor (per bay where bays get
// their own colour), and the windows, shopfronts, roller doors, roof sheeting
// and tiles come from one small generated texture atlas. The atlas alpha is a
// tint mask: where it is 1 the texel is multiplied by the vertex colour (wall
// paint, roof colour), where it is 0 the texel is used as is (glass, frames).
// Geometry is merged into one mesh per CHUNK, all sharing one material.
//
// Map space: x east, y north. World: (x, height, -y).

import * as THREE from 'three';
import { enhanceBuildingMaterial } from './materials.js';

const CHUNK = 1000;

// ---------------------------------------------------------------- randomness
function ihash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return n >>> 0;
}
// deterministic per-building random stream: rnd(k) in [0,1)
function seeded(x, y) {
  const s = ihash(Math.imul(Math.round(x * 10), 73856093) ^ ihash(Math.imul(Math.round(y * 10), 19349663)));
  return (k) => ihash(s ^ Math.imul(k + 1, 0x9e3779b1)) / 4294967296;
}
const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

// ---------------------------------------------------------------- palette
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const P = (list) => list.map(lin);
const PAL = {
  houseWall: P([0xefe8d8, 0xe7dcc3, 0xdccdae, 0xdad7ce, 0xd2ae88, 0xc99a74, 0xbd8f78, 0xe9e0c8]),
  roofTin: P([0x50565b, 0x6f7477, 0x8d918f, 0x737a70, 0xa8acaa, 0x8a8f94]),
  roofTile: P([0xa95e43, 0x94523f, 0x80665a, 0x6a6562, 0xb5704f]),
  fascia: P([0xeeebe2, 0xe4e0d4]),
  soffit: lin(0xe9e5da),
  shopWall: P([0xece2ca, 0xdccfb3, 0xcbb99a, 0xbec4ae, 0xd2a88c, 0xb6bec2, 0xe6d4a6, 0xb27f66, 0xe2ddd2]),
  awning: P([0x3e4b45, 0x6b3d38, 0x3b3e43, 0xd8d0bc, 0x56666e, 0x7b6a52]),
  awningTop: lin(0xa9adac),
  awningUnder: lin(0xf4f1ea),
  flatRoof: P([0xa7a9a6, 0xb4b2aa, 0x9a9ea0, 0xbbb7ad]),
  parapetCap: lin(0xd9d5cb),
  plant: P([0xc9cbc8, 0xb3b6b5, 0xd6d4cc]),
  aptWall: P([0xece6d8, 0xe2dccd, 0xd9d4c9, 0xe6dcc6, 0xcdb9a0]),
  civicWall: P([0xc99c7a, 0xb8846c, 0xddd0b4, 0xd4c3a3]),
  civicRoof: P([0x8f4c3c, 0x5c6266, 0xa65b41, 0x7c8285]),
  indWall: P([0xdcdad0, 0xc5c7c3, 0xb1b3ad, 0xcdc5b1, 0xa0a59e, 0xe5e2d9, 0x8f9a94]),
  indRoof: P([0xb6babb, 0xaaaeaf, 0x9ca1a2, 0xc3c5c1]),
  canopy: P([0xdcdcd6, 0xcfd2d0, 0xc9c4b8]),
  canopyRoof: P([0xe4e4de, 0xd2d4d2]),
  tank: P([0xe3e3dd, 0xd6d6cf]),
  silo: P([0xcfcac0, 0xbdb8ae]),
  tower: P([0xbfb6a6]),
};

// Default heights the map builder assigns per kind when OSM has no
// height / building:levels tag; anything else is treated as real data.
const DEFAULT_H = [
  [4.5, 4.2, 5, 6, 12], [7.5, 6.5, 9, 7, 15], [8, 5], [16, 11, 6.5, 14, 6, 5],
  [4, 2.8], [3], [28], [12], [14],
];

// CBD of Bunbury: a capsule along Victoria Street plus the blocks either side
function cbdness(x, y) {
  const y0 = -170, y1 = 650;
  const cy = Math.max(y0, Math.min(y1, y));
  const d = Math.hypot(x + 20, y - cy);
  return d < 260 ? 1 : d < 380 ? (380 - d) / 120 : 0;
}

// ---------------------------------------------------------------- atlas
const TW = 256, TH = 1024;
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const T = (f) => { const v = Math.max(0, Math.min(255, Math.round(255 * f))); return [v, v, v, 255]; };
const U = (hex) => [...rgb(hex), 0];
const mixHex = (a, b, t) => { const A = rgb(a), B = rgb(b); return [0, 1, 2].map((i) => Math.round(A[i] + (B[i] - A[i]) * t)).concat(0); };

function buildAtlas() {
  const data = new Uint8Array(TW * TH * 4);
  const rows = {};
  let y = 0;
  const row = (name, h, paint) => {
    const pad = 6, y0 = y + pad;
    for (let py = y; py < y0 + h + pad; py++) {
      const ly = Math.min(h - 1, Math.max(0, py - y0));
      for (let px = 0; px < TW; px++) {
        const c = paint(px, ly, (px + 0.5) / TW, (ly + 0.5) / h);
        const i = (py * TW + px) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
      }
    }
    rows[name] = [y0 / TH, (y0 + h) / TH];
    y = y0 + h + pad;
  };
  const inR = (fx, fy, x0, x1, y0, y1) => fx >= x0 && fx < x1 && fy >= y0 && fy < y1;
  // window with a frame: frame width in px (fw) and rows (fh)
  const glass = (fy, y0, y1, top = 0xa2b7c3, bot = 0x4c6574) => mixHex(bot, top, (fy - y0) / (y1 - y0));
  const sash = (px, py, fx, fy, x0, x1, y0, y1, h, frame, mull) => {
    if (!inR(fx, fy, x0, x1, y0, y1)) return null;
    const fw = 3 / TW, fh = 3 / h;
    if (fx < x0 + fw || fx >= x1 - fw || fy < y0 + fh || fy >= y1 - fh) return U(frame);
    for (const m of mull) {
      if (m[0] === 'v' && Math.abs(fx - m[1]) < 1.2 / TW) return U(frame);
      if (m[0] === 'h' && Math.abs(fy - m[1]) < 1.2 / h) return U(frame);
    }
    return glass(fy, y0, y1);
  };

  row('solid', 16, () => T(1));
  // house wall, one tile ~4.4 m wide x wall height: one window, plinth
  row('house', 64, (px, py, fx, fy) => {
    if (fy < 0.07) return T(0.84);
    const w = sash(px, py, fx, fy, 0.33, 0.67, 0.33, 0.8, 64, 0xf3f1ea, [['v', 0.5]]);
    if (w) return w;
    if (inR(fx, fy, 0.31, 0.69, 0.29, 0.33)) return U(0xd9d5cc);
    return T(1);
  });
  // house wall variant: wider sliding window
  row('house2', 64, (px, py, fx, fy) => {
    if (fy < 0.07) return T(0.84);
    const w = sash(px, py, fx, fy, 0.22, 0.78, 0.36, 0.8, 64, 0xf3f1ea, [['v', 0.41], ['v', 0.59]]);
    if (w) return w;
    if (inR(fx, fy, 0.2, 0.8, 0.32, 0.36)) return U(0xd9d5cc);
    return T(1);
  });
  // shop ground floor bay (0..4.2 m): pilasters, granite stall riser,
  // glazing with a door, sign band above (awning sits at ~3.2 m)
  row('shop', 112, (px, py, fx, fy) => {
    if (fx < 0.05 || fx >= 0.95) return T(0.93);
    if (fy < 0.09) return U(0x4a4744);
    const fr = 0xc5c9ca;
    if (fy < 0.7) {
      const fw = 2.5 / TW, fh = 2.5 / 112;
      if (fx < 0.05 + fw || fx >= 0.95 - fw || fy >= 0.7 - fh) return U(fr);
      if (inR(fx, fy, 0.09, 0.3, 0, 0.66)) { // door
        if (fx < 0.09 + fw || fx >= 0.3 - fw || fy >= 0.66 - fh) return U(0x8d9294);
        return glass(fy, 0, 0.66, 0x7a919e, 0x34464f);
      }
      if (Math.abs(fx - 0.3) < fw || Math.abs(fx - 0.64) < fw * 0.7) return U(fr);
      if (fy < 0.09 + fh) return U(fr);
      return glass(fy, 0.09, 0.7, 0xa5bac6, 0x4f6876);
    }
    if (fy < 0.74) return T(0.82);
    return T(1);
  });
  // upper floor of a main-street building (3.4 m): two tall sash windows
  row('upper', 80, (px, py, fx, fy) => {
    if (fy > 0.95) return T(0.86);
    if (fy < 0.04) return T(0.9);
    for (const [x0, x1] of [[0.15, 0.37], [0.63, 0.85]]) {
      const w = sash(px, py, fx, fy, x0, x1, 0.24, 0.8, 80, 0xf1efe8, [['h', 0.52]]);
      if (w) return w;
      if (inR(fx, fy, x0 - 0.02, x1 + 0.02, 0.21, 0.24)) return T(0.8);
    }
    return T(1);
  });
  // modern floor: ribbon glazing with mullions
  row('modern', 80, (px, py, fx, fy) => {
    if (fy < 0.28 || fy >= 0.9) return T(fy < 0.06 ? 0.9 : 1);
    if (fy < 0.3 || fy >= 0.88) return U(0xb9bec2);
    const m = (fx * 4) % 1;
    if (m < 0.012 || m > 0.988) return U(0xb9bec2);
    return glass(fy, 0.3, 0.88, 0xa8bcc7, 0x4d6676);
  });
  // ribbed metal cladding (vertical ribs)
  row('clad', 32, (px) => { const m = px % 8; return T(m < 2 ? 0.86 : m === 2 ? 1 : 0.95); });
  // industrial bay with a roller door (0..5.5 m)
  row('door', 96, (px, py, fx, fy) => {
    if (inR(fx, fy, 0.17, 0.83, 0, 0.82)) {
      if (fx < 0.19 || fx >= 0.81 || fy >= 0.79) return U(0x5f6467);
      return U(py % 4 === 0 ? 0x7d8184 : 0x9b9fa1);
    }
    const m = px % 8; return T(m < 2 ? 0.86 : m === 2 ? 1 : 0.95);
  });
  // roof tiles: four courses across u (u runs up the slope, so any slope
  // length repeats cleanly); shadow line at the foot of each course
  row('tile', 16, (px, py, fx) => {
    const f = (fx * 4) % 1;
    return T(f < 0.12 ? 0.84 : 1 - 0.07 * f);
  });
  // corrugated / trimdek roof sheeting: ribs running down the slope
  row('tin', 16, (px) => { const m = px % 16; return T(m < 2 ? 0.86 : m < 4 ? 1 : 0.95); });
  // solar panels
  row('solar', 32, (px, py, fx, fy) => {
    if (px % 32 < 2 || py < 1 || py > 30) return U(0xb8bdc2);
    if (px % 8 === 0 || py % 8 === 0) return U(0x3a4a66);
    return mixHex(0x1b2740, 0x2d3f60, fy);
  });

  const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { tex, rows };
}

function buildingMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex });
  // texel * (alpha ? vertex colour : 1)
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', 'vec4 bTex = texture2D( map, vMapUv );\n\tdiffuseColor.rgb *= bTex.rgb * mix( vec3( 1.0 ), vColor, bTex.a );')
      .replace('#include <color_fragment>', '');
  };
  mat.customProgramCacheKey = () => 'building-tint-atlas';
  return enhanceBuildingMaterial(mat); // contact shading, weathering, shadows (src/materials.js)
}

// ---------------------------------------------------------------- 2D helpers
function ringArea(p) { // p: [[x,y]]
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}
function toPts(f) { const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], f[i + 1]]); return o; }
function inRing(x, y, r) { // r flat
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Douglas-Peucker on a closed ring
function simplifyRing(pts, tol) {
  const q = [];
  for (const p of pts) { const l = q[q.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.05) q.push(p); }
  if (q.length > 1 && Math.hypot(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]) < 0.05) q.pop();
  const n = q.length;
  if (n <= 3) return q;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (q[i][0] - q[0][0]) ** 2 + (q[i][1] - q[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const dp = (i, j) => {
    const a = q[i], b = q[j % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((q[k][0] - a[0]) * dy - (q[k][1] - a[1]) * dx) / l;
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; dp(i, best); dp(best, j); }
  };
  dp(0, far); dp(far, n);
  const out = q.filter((_, i) => keep[i]);
  return out.length >= 3 && ringArea(out) > 0 ? out : q;
}

// Offset a CCW ring by d (positive = inward), mitred corners.
function offsetRing(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    let e0x = p1[0] - p0[0], e0y = p1[1] - p0[1]; const l0 = Math.hypot(e0x, e0y) || 1e-9; e0x /= l0; e0y /= l0;
    let e1x = p2[0] - p1[0], e1y = p2[1] - p1[1]; const l1 = Math.hypot(e1x, e1y) || 1e-9; e1x /= l1; e1y /= l1;
    const ax = p1[0] - e0y * d, ay = p1[1] + e0x * d, bx = p1[0] - e1y * d, by = p1[1] + e1x * d;
    const cr = e0x * e1y - e0y * e1x;
    if (Math.abs(cr) < 1e-4) { out.push([bx, by]); continue; }
    const s = ((bx - ax) * e1y - (by - ay) * e1x) / cr;
    out.push([ax + s * e0x, ay + s * e0y]);
  }
  return out;
}
function segX(a, b, c, d) {
  const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
// offset ring keeps every edge's direction and does not self-intersect
function offsetOk(orig, off) {
  const n = orig.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ox = orig[j][0] - orig[i][0], oy = orig[j][1] - orig[i][1];
    const fx = off[j][0] - off[i][0], fy = off[j][1] - off[i][1];
    if (fx * ox + fy * oy <= 1e-3 * Math.hypot(ox, oy)) return false;
  }
  if (n > 3) {
    for (let i = 0; i < n; i++) for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      if (segX(off[i], off[(i + 1) % n], off[k], off[(k + 1) % n])) return false;
    }
  }
  return true;
}
// largest valid inset up to dMax (bisection)
function maxInset(pts, dMax) {
  if (offsetOk(pts, offsetRing(pts, dMax))) return dMax;
  let lo = 0, hi = dMax;
  for (let k = 0; k < 11; k++) {
    const m = (lo + hi) / 2;
    if (offsetOk(pts, offsetRing(pts, m))) lo = m; else hi = m;
  }
  return lo;
}
function nearRect(pts) {
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
    const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
    if (Math.abs(ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)) > 0.17) return false;
  }
  return true;
}
// main axis angle: direction of the longest edge
function mainAxis(pts) {
  let best = 0, ang = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return ang;
}

// ---------------------------------------------------------------- lookups
class Env {
  constructor(data, buildings) {
    this.G = 32;
    this.roads = new Map();
    for (const r of data.roads) {
      if (r.c > 5) continue; // only real streets get shopfronts / awnings
      const hw = r.w / 2, pad = hw + 22, p = r.p;
      for (let i = 0; i < p.length - 2; i += 2) {
        const s = [p[i], p[i + 1], p[i + 2], p[i + 3], hw];
        this.insert(this.roads, Math.min(s[0], s[2]) - pad, Math.min(s[1], s[3]) - pad, Math.max(s[0], s[2]) + pad, Math.max(s[1], s[3]) + pad, s);
      }
    }
    this.foot = new Map();
    buildings.forEach((b, i) => {
      if (b.k === 4) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < b.p.length; k += 2) { x0 = Math.min(x0, b.p[k]); x1 = Math.max(x1, b.p[k]); y0 = Math.min(y0, b.p[k + 1]); y1 = Math.max(y1, b.p[k + 1]); }
      this.insert(this.foot, x0, y0, x1, y1, { i, p: b.p, bb: [x0, y0, x1, y1] });
    });
  }
  insert(map, x0, y0, x1, y1, v) {
    const G = this.G;
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++)
      for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) {
        const k = gx * 65536 + gy;
        let c = map.get(k);
        if (!c) { c = []; map.set(k, c); }
        c.push(v);
      }
  }
  cell(map, x, y) { return map.get(Math.floor(x / this.G) * 65536 + Math.floor(y / this.G)); }
  // nearest street within ~22 m: {gap (to road edge), ux, uy (unit dir to it)}
  road(x, y) {
    const c = this.cell(this.roads, x, y);
    if (!c) return null;
    let best = null, bd = Infinity;
    for (const s of c) {
      const dx = s[2] - s[0], dy = s[3] - s[1];
      const l2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - s[0]) * dx + (y - s[1]) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s[0] + dx * t, py = s[1] + dy * t;
      const d = Math.hypot(px - x, py - y);
      if (d - s[4] < bd) { bd = d - s[4]; best = { gap: d - s[4], ux: (px - x) / (d || 1), uy: (py - y) / (d || 1) }; }
    }
    return best;
  }
  inFoot(x, y, self) {
    const c = this.cell(this.foot, x, y);
    if (!c) return false;
    for (const f of c) {
      if (f.i === self || x < f.bb[0] || x > f.bb[2] || y < f.bb[1] || y > f.bb[3]) continue;
      if (inRing(x, y, f.p)) return true;
    }
    return false;
  }
  // classify a wall edge: 'street' (faces a street close by), 'party'
  // (another building right behind it) or 'side'
  edge(ax, ay, bx, by, nx, ny, self) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (this.inFoot(mx + nx * 0.7, my + ny * 0.7, self)) return { type: 'party' };
    const r = this.road(mx + nx * 0.3, my + ny * 0.3);
    if (!r || r.gap > 16 || r.ux * nx + r.uy * ny < 0.72) return { type: 'side' };
    if (this.inFoot(mx + nx * Math.min(r.gap, 5), my + ny * Math.min(r.gap, 5), self)) return { type: 'side' };
    let gap = r.gap;
    for (const t of [0.15, 0.85]) {
      const q = this.road(ax + (bx - ax) * t + nx * 0.3, ay + (by - ay) * t + ny * 0.3);
      if (q && q.ux * nx + q.uy * ny > 0.3) gap = Math.min(gap, q.gap);
    }
    return { type: 'street', gap };
  }
}

// ---------------------------------------------------------------- geometry
class Geo {
  constructor(rows) { this.rows = rows; this.chunks = new Map(); this.o = null; this.tris = 0; }
  at(x, y) {
    const k = Math.floor(x / CHUNK) * 4096 + Math.floor(y / CHUNK);
    let o = this.chunks.get(k);
    if (!o) { o = { p: [], n: [], c: [], t: [] }; this.chunks.set(k, o); }
    this.o = o;
  }
  // world-space triangle; flat normal; winding flipped to agree with hint
  tri(a, b, c, ca, cb, cc, ta, tb, tc, hint) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-7) return;
    nx /= l; ny /= l; nz /= l;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      let t = b; b = c; c = t; t = cb; cb = cc; cc = t; t = tb; tb = tc; tc = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    const o = this.o;
    o.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    o.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    o.c.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    o.t.push(ta[0], ta[1], tb[0], tb[1], tc[0], tc[1]);
    this.tris++;
  }
  quad(A, B, C, D, cA, cB, cC, cD, tA, tB, tC, tD, hint) {
    this.tri(A, B, C, cA, cB, cC, tA, tB, tC, hint);
    this.tri(A, C, D, cA, cC, cD, tA, tC, tD, hint);
  }
  // vertical wall quad on edge a->b (outward = right side), y0..y1,
  // texture row `row` spanning rv0..rv1 (fractions of the row), u0..u1
  wall(ax, ay, bx, by, y0, y1, row, u0, u1, cBot, cTop, rv0 = 0, rv1 = 1) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05 || y1 - y0 < 0.01) return;
    const [v0, v1] = this.rows[row];
    const va = v0 + (v1 - v0) * rv0, vb = v0 + (v1 - v0) * rv1;
    const hint = [(by - ay) / len, 0, (bx - ax) / len];
    this.quad([ax, y0, -ay], [bx, y0, -by], [bx, y1, -by], [ax, y1, -ay], cBot, cBot, cTop, cTop,
      [u0, va], [u1, va], [u1, vb], [u0, vb], hint);
  }
  // flat polygon (with holes) at height y, facing up (or down)
  flat(rings, y, color, down = false) {
    const toV = (r) => r.map((p) => new THREE.Vector2(p[0], p[1]));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(toV(rings[0]), rings.slice(1).map(toV)); } catch (e) { return; }
    const pts = [].concat(...rings);
    const v = this.rows.solid[0] + 0.004;
    const tv = [0.5, v];
    const hint = down ? [0, -1, 0] : [0, 1, 0];
    for (const [a, b, c] of tris) {
      this.tri([pts[a][0], y, -pts[a][1]], [pts[b][0], y, -pts[b][1]], [pts[c][0], y, -pts[c][1]], color, color, color, tv, tv, tv, hint);
    }
  }
  // axis-aligned-to-angle box (sides + top)
  box(cx, cy, ang, sx, sy, y0, y1, color, top) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const c = [[-sx, -sy], [sx, -sy], [sx, sy], [-sx, sy]].map(([u, v]) => [cx + u * ca - v * sa, cy + u * sa + v * ca]);
    const dark = shade(color, 0.9);
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      this.wall(a[0], a[1], b[0], b[1], y0, y1, 'solid', 0, 1, dark, color);
    }
    this.flat([c], y1, top || color);
  }
}

const shade = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- roofs
// Hipped roof over any simple footprint: the eave ring (footprint pushed out
// by `eave`) rises at slope `pitch` to an inset ring, capped flat. For a
// rectangle the inset collapses to the ridge line, giving a true hip roof.
// Walls stop at the soffit (height W) so they can never poke through.
function hipRoof(G, pts, W, o) {
  const { pitch, eave, roofC, roofRow, fasciaC, maxRise = 4 } = o;
  if (pts.length < 3 || pts.length > 48) return false;
  const A = ringArea(pts);
  let per = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; per += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const dMax = Math.min(maxRise / pitch, (2 * A) / per + 0.05);
  const d = maxInset(pts, dMax);
  if (d < Math.min(1.1, dMax * 0.8)) return false;
  let e = eave, E = offsetRing(pts, -e);
  if (!offsetOk(pts, E)) { e = eave * 0.4; E = offsetRing(pts, -e); if (!offsetOk(pts, E)) { e = 0; E = pts; } }
  const I = offsetRing(pts, d);
  const fh = e > 0 ? 0.2 : 0;
  const Ye = W + fh, Yt = Ye + (d + e) * pitch;
  const [rv0, rv1] = G.rows[roofRow];
  const n = pts.length;
  const cEave = shade(roofC, 0.9);
  // soffit band: from the eave ring in to well inside the walls
  if (e > 0) {
    const S = offsetRing(pts, Math.min(1, d * 0.45));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      G.quad([E[i][0], W, -E[i][1]], [E[j][0], W, -E[j][1]], [S[j][0], W, -S[j][1]], [S[i][0], W, -S[i][1]],
        PAL.soffit, PAL.soffit, PAL.soffit, PAL.soffit, [0, G.rows.solid[0]], [0, G.rows.solid[0]], [0, G.rows.solid[0]], [0, G.rows.solid[0]], [0, -1, 0]);
      G.wall(E[i][0], E[i][1], E[j][0], E[j][1], W, Ye, 'solid', 0, 1, fasciaC, fasciaC);
    }
  }
  let solarEdge = -1;
  if (o.solar) {
    let bestN = 0.55;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ny = -(b[0] - a[0]) / l;
      if (l > 5 && ny > bestN) { bestN = ny; solarEdge = i; }
    }
    if (d + e < 2.4) solarEdge = -1;
  }
  const tileW = 3.2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = pts[j][0] - pts[i][0], ey = pts[j][1] - pts[i][1], el = Math.hypot(ex, ey);
    const dx = ex / el, dy = ey / el;
    // tin: u along the eave (ribs run down the slope); tiles: u up the slope
    const slope = Math.sqrt(1 + pitch * pitch);
    const uv = roofRow === 'tile'
      ? (p) => [(-(p[0] - E[i][0]) * dy + (p[1] - E[i][1]) * dx) * slope / 1.7, (rv0 + rv1) / 2]
      : (p, top) => [((p[0] - E[i][0]) * dx + (p[1] - E[i][1]) * dy) / tileW, top ? rv1 : rv0];
    const hint = [dy * pitch, 1, dx * pitch]; // outward (dy,-dx) in map -> world (dy, ., dx)
    const a = [E[i][0], Ye, -E[i][1]], b = [E[j][0], Ye, -E[j][1]], c = [I[j][0], Yt, -I[j][1]], dd = [I[i][0], Yt, -I[i][1]];
    G.quad(a, b, c, dd, cEave, cEave, roofC, roofC, uv(E[i], 0), uv(E[j], 0), uv(I[j], 1), uv(I[i], 1), hint);
    if (i === solarEdge) {
      // panel array on the north-facing slope, lifted off the roof plane
      const L = Math.hypot(hint[0], hint[1], hint[2]);
      const off = [hint[0] / L * 0.07, hint[1] / L * 0.07, hint[2] / L * 0.07];
      const s0 = 0.24, s1 = 0.76, t0 = 0.18, t1 = 0.72;
      const at = (s, t) => { const p = lerp3(lerp3(a, b, s), lerp3(dd, c, s), t); return [p[0] + off[0], p[1] + off[1], p[2] + off[2]]; };
      const cols = Math.max(1, Math.round((s1 - s0) * el / 1.1));
      const [sv0, sv1] = G.rows.solar;
      const w = [1, 1, 1];
      G.quad(at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1), w, w, w, w, [0, sv0], [cols, sv0], [cols, sv1], [0, sv1], hint);
    }
  }
  if (ringArea(I) > 0.4) G.flat([I], Yt, roofC);
  return true;
}

// Gable roof over a near-rectangular footprint (sheds, factories); ridge
// along the long axis, gable ends filled with wall.
function gableRoof(G, pts, W, o) {
  const { pitch, eave, roofC, wallC, wallRow } = o;
  let q = pts;
  const l0 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[3][0] - q[2][0], q[3][1] - q[2][1]);
  const l1 = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]) + Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1]);
  if (l1 > l0) q = [q[1], q[2], q[3], q[0]]; // q0-q1 and q2-q3 are the long sides
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const halfW = (Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]) + Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1])) / 4;
  const Yr = W + halfW * pitch;
  const m1 = mid(q[1], q[2]), m3 = mid(q[3], q[0]);
  // gable end walls
  for (const [a, b, m] of [[q[1], q[2], m1], [q[3], q[0], m3]]) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 6));
    const [v0, v1] = G.rows[wallRow];
    const hint = [(b[1] - a[1]) / len, 0, (b[0] - a[0]) / len];
    G.tri([a[0], W, -a[1]], [b[0], W, -b[1]], [m[0], Yr, -m[1]], wallC, wallC, wallC, [0, v0 + (v1 - v0) * 0.6], [n, v0 + (v1 - v0) * 0.6], [n / 2, v1], hint);
  }
  // roof planes, pushed out by `eave` on all sides
  const ax = (q[1][0] - q[0][0]), ay = (q[1][1] - q[0][1]), al = Math.hypot(ax, ay);
  const dx = ax / al, dy = ay / al;
  const ext = (p, s, side) => [p[0] + dx * eave * s + (side ? dy : -dy) * eave, p[1] + dy * eave * s + (side ? -dx : dx) * eave];
  const Ye = W - eave * pitch;
  const [rv0, rv1] = G.rows.tin;
  const cE = shade(roofC, 0.92);
  const r0 = [m3[0] - dx * eave, m3[1] - dy * eave], r1 = [m1[0] + dx * eave, m1[1] + dy * eave];
  // side A: q0 -> q1 (outward = right of q0->q1)
  const A0 = ext(q[0], -1, true), A1 = ext(q[1], 1, true);
  const uA = (p) => ((p[0] - A0[0]) * dx + (p[1] - A0[1]) * dy) / 3.2;
  G.quad([A0[0], Ye, -A0[1]], [A1[0], Ye, -A1[1]], [r1[0], Yr, -r1[1]], [r0[0], Yr, -r0[1]], cE, cE, roofC, roofC,
    [uA(A0), rv0], [uA(A1), rv0], [uA(r1), rv1], [uA(r0), rv1], [dy * pitch, 1, dx * pitch]);
  // side B: q2 -> q3
  const B0 = ext(q[2], 1, false), B1 = ext(q[3], -1, false);
  G.quad([B0[0], Ye, -B0[1]], [B1[0], Ye, -B1[1]], [r0[0], Yr, -r0[1]], [r1[0], Yr, -r1[1]], cE, cE, roofC, roofC,
    [-uA(B0), rv0], [-uA(B1), rv0], [-uA(r0), rv1], [-uA(r1), rv1], [-dy * pitch, 1, -dx * pitch]);
  return true;
}

// Flat roof with parapet (inner face + capping), optional rooftop plant.
function flatRoof(G, rings, top, para, roofC, wallC, R, plant) {
  G.flat(rings, top, roofC);
  if (para > 0.05) {
    const outer = rings[0];
    const inner = offsetRing(outer, 0.3);
    if (offsetOk(outer, inner)) {
      const n = outer.length, inC = shade(wallC, 0.82);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        // inner face: edge j->i so its outward side faces the roof
        G.wall(inner[j][0], inner[j][1], inner[i][0], inner[i][1], top, top + para, 'solid', 0, 1, shade(inC, 0.85), inC);
        const sv = [0, G.rows.solid[0]];
        G.quad([outer[i][0], top + para, -outer[i][1]], [outer[j][0], top + para, -outer[j][1]], [inner[j][0], top + para, -inner[j][1]], [inner[i][0], top + para, -inner[i][1]],
          PAL.parapetCap, PAL.parapetCap, PAL.parapetCap, PAL.parapetCap, sv, sv, sv, sv, [0, 1, 0]);
      }
    }
  }
  if (plant) {
    const outer = rings[0];
    const flatO = [].concat(...outer);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of outer) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const ang = mainAxis(outer);
    let placed = 0;
    for (let k = 0; k < 10 && placed < plant; k++) {
      const cx = x0 + (x1 - x0) * (0.15 + 0.7 * R(200 + k * 3)), cy = y0 + (y1 - y0) * (0.15 + 0.7 * R(201 + k * 3));
      const sx = 0.8 + R(202 + k * 3) * 1.4, sy = 0.7 + R(203 + k * 5) * 1.0, h = 0.9 + R(204 + k * 7) * 0.8;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let ok = true;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
        const px = cx + (u * (sx + 1.2)) * ca - (v * (sy + 1.2)) * sa, py = cy + (u * (sx + 1.2)) * sa + (v * (sy + 1.2)) * ca;
        if (!inRing(px, py, flatO)) { ok = false; break; }
        for (const hr of rings.slice(1)) if (inRing(px, py, [].concat(...hr))) ok = false;
      }
      if (!ok) continue;
      G.box(cx, cy, ang, sx, sy, top, top + h, pick(PAL.plant, R(205 + k)));
      placed++;
    }
  }
}

// ---------------------------------------------------------------- archetypes
function eachEdge(ring, fn) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    fn(a[0], a[1], b[0], b[1], len, (b[1] - a[1]) / len, -(b[0] - a[0]) / len, i);
  }
}

function house(G, B, opt = {}) {
  const { R, rings, simp } = B;
  const storeys = opt.storeys || 1;
  let W = opt.W || (storeys === 2 ? 5.5 + 0.4 * R(1) : 2.65 + 0.35 * R(1));
  const wallC = shade(pick(opt.wallPal || PAL.houseWall, R(2)), 0.96 + 0.08 * R(3));
  const tile = R(4) < (opt.tileChance ?? 0.42);
  const roofC = shade(pick(opt.roofPal || (tile ? PAL.roofTile : PAL.roofTin), R(5)), 0.95 + 0.1 * R(6));
  const pitch = opt.pitch || (tile ? 0.46 : 0.36 + 0.1 * R(7));
  const row = opt.row || (R(8) < 0.5 ? 'house' : 'house2');
  const fasciaC = R(9) < 0.6 ? pick(PAL.fascia, R(10)) : shade(roofC, 1.1);
  const floorH = W / storeys;
  const tileW = opt.tileW || 4.4;
  const bot = shade(wallC, 0.82), mid = shade(wallC, 0.97);
  for (const ring of rings) {
    eachEdge(ring, (ax, ay, bx, by, len) => {
      const r = len >= 2.6 ? row : 'solid';
      const n = Math.max(1, Math.round(len / tileW));
      for (let f = 0; f < storeys; f++) {
        G.wall(ax, ay, bx, by, f * floorH, (f + 1) * floorH, r, 0, n, f === 0 ? bot : mid, f === storeys - 1 ? wallC : mid);
      }
    });
  }
  const ok = rings.length === 1 && hipRoof(G, simp, W, {
    pitch, eave: opt.eave ?? 0.5, roofC, roofRow: tile ? 'tile' : 'tin', fasciaC, solar: R(11) < (opt.solarChance ?? 0.35), maxRise: opt.maxRise || 3.6,
  });
  if (!ok) {
    // flat / skillion-looking roof with a low parapet
    for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, W, W + 0.45, 'solid', 0, 1, wallC, wallC));
    flatRoof(G, rings, W + 0.15, 0.3, shade(roofC, 1.1), wallC, R, 0);
  }
}

function shop(G, B, env) {
  const { R, rings, A, b, bi, explicit } = B;
  const big = A > 1500;
  let Hg = big ? 4.8 : 4.2;
  let floors;
  if (explicit) floors = Math.max(1, Math.round((b.h - 1) / 3.5));
  else if (b.k === 1 && b.h >= 15) floors = 4 + Math.floor(R(1) * 2);
  else if (b.k === 1 && b.h === 9) floors = 2 + Math.floor(R(1) * 2);
  else if (big) floors = R(1) < 0.6 ? 1 : 2;
  else if (A < 150) floors = R(1) < 0.7 ? 1 : 2;
  else { const r = R(1); floors = r < 0.35 ? 1 : r < 0.8 ? 2 : r < 0.94 ? 3 : 4; }
  let Hu = 3.4;
  let top = Hg + (floors - 1) * Hu;
  if (explicit) {
    top = Math.max(3.4, b.h - 0.8);
    Hg = Math.min(Hg, top);
    if (floors > 1) Hu = (top - Hg) / (floors - 1);
  }
  const para = 0.7 + 0.6 * R(2);
  const base = pick(PAL.shopWall, R(3));
  const modern = floors >= 4 || R(4) < 0.22;
  const upRow = modern ? 'modern' : 'upper';
  const bayW = 5.5 + 2.5 * R(5);
  const terrace = R(6) < 0.75;
  const awnC = pick(PAL.awning, R(7));
  const groundTop = floors === 1 ? top : Hg;
  rings.forEach((ring, ri) => {
    eachEdge(ring, (ax, ay, bx, by, len, nx, ny, ei) => {
      const ed = ri === 0 ? env.edge(ax, ay, bx, by, nx, ny, bi) : { type: 'party' };
      const street = ed.type === 'street' && len > 2.5;
      const n = Math.max(1, Math.round(len / bayW));
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const vary = street && terrace && len > 11;
      const one = !vary; // draw the edge as one quad per floor
      const bays = one ? 1 : n;
      for (let j = 0; j < bays; j++) {
        const s0 = (len * j) / bays, s1 = (len * (j + 1)) / bays;
        const x0 = ax + dx * s0, y0 = ay + dy * s0, x1 = ax + dx * s1, y1 = ay + dy * s1;
        const c = vary && R(300 + ei * 17 + j) < 0.7 ? pick(PAL.shopWall, R(301 + ei * 17 + j)) : street ? base : shade(base, 0.94);
        const u1 = one ? n : 1;
        const cb = shade(c, 0.85);
        // ground floor
        if (street) G.wall(x0, y0, x1, y1, 0, Hg, 'shop', 0, u1, cb, c, 0, 1);
        else if (ed.type === 'side' && len > 4 && !big) G.wall(x0, y0, x1, y1, 0, groundTop, floors === 1 ? 'upper' : 'solid', 0, u1, cb, c);
        else G.wall(x0, y0, x1, y1, 0, groundTop, 'solid', 0, u1, cb, c);
        if (street && floors === 1 && top > Hg) G.wall(x0, y0, x1, y1, Hg, top, 'solid', 0, u1, c, c);
        // upper floors
        for (let f = 1; f < floors; f++) {
          const r = ed.type === 'party' ? 'solid' : upRow;
          G.wall(x0, y0, x1, y1, Hg + (f - 1) * Hu, Hg + f * Hu, r, 0, u1, c, c);
        }
        // parapet, a touch lighter
        G.wall(x0, y0, x1, y1, top, top + para, 'solid', 0, 1, shade(c, 1.04), shade(c, 1.06));
      }
      // verandah awning over the footpath
      if (street && ed.gap > 1.5 && len > 3 && Hg >= 3.8) {
        const depth = Math.min(3.0, ed.gap - 0.4);
        const s0 = 0.05, s1 = len - 0.05;
        const fx = nx * depth, fy = ny * depth;
        const p0 = [ax + dx * s0, ay + dy * s0], p1 = [ax + dx * s1, ay + dy * s1];
        if (env.inFoot(p0[0] + fx, p0[1] + fy, bi) || env.inFoot(p1[0] + fx, p1[1] + fy, bi)) return;
        const Ya = 3.3, yb = Ya - 0.32, yTopB = Ya + 0.38, yTopF = Ya + 0.12;
        const q0 = [p0[0] + fx, p0[1] + fy], q1 = [p1[0] + fx, p1[1] + fy];
        const sv = [0, G.rows.solid[0]];
        const [tv0, tv1] = G.rows.tin;
        // roof sheet (ribs run outwards)
        const tc = PAL.awningTop;
        G.quad([p0[0], yTopB, -p0[1]], [p1[0], yTopB, -p1[1]], [q1[0], yTopF, -q1[1]], [q0[0], yTopF, -q0[1]], tc, tc, tc, tc,
          [0, tv1], [len / 1.6, tv1], [len / 1.6, tv0], [0, tv0], [0, 1, 0]);
        // underside
        const uc = PAL.awningUnder;
        G.quad([p0[0], yb, -p0[1]], [q0[0], yb, -q0[1]], [q1[0], yb, -q1[1]], [p1[0], yb, -p1[1]], uc, uc, uc, uc, sv, sv, sv, sv, [0, -1, 0]);
        // fascia per bay (colour varies along a terrace)
        const nb = vary ? n : 1;
        for (let j = 0; j < nb; j++) {
          const t0 = j / nb, t1 = (j + 1) / nb;
          const ca = vary && R(400 + ei * 13 + j) < 0.5 ? pick(PAL.awning, R(401 + ei * 13 + j)) : awnC;
          G.wall(q0[0] + (q1[0] - q0[0]) * t0, q0[1] + (q1[1] - q0[1]) * t0, q0[0] + (q1[0] - q0[0]) * t1, q0[1] + (q1[1] - q0[1]) * t1,
            yb, yTopF, 'solid', 0, 1, shade(ca, 0.9), ca);
        }
        // end caps
        const ce = shade(awnC, 0.85);
        G.quad([p0[0], yb, -p0[1]], [p0[0], yTopB, -p0[1]], [q0[0], yTopF, -q0[1]], [q0[0], yb, -q0[1]], ce, ce, ce, ce, sv, sv, sv, sv, [-dx, 0, dy]);
        G.quad([p1[0], yb, -p1[1]], [q1[0], yb, -q1[1]], [q1[0], yTopF, -q1[1]], [p1[0], yTopB, -p1[1]], ce, ce, ce, ce, sv, sv, sv, sv, [dx, 0, -dy]);
      }
    });
  });
  const plant = A > 250 ? Math.min(4, 1 + Math.floor(A / 700)) : 0;
  flatRoof(G, rings, top, para, pick(PAL.flatRoof, R(9)), base, R, plant);
}

function apartments(G, B) {
  const { R, rings, simp, b, explicit } = B;
  const floors = explicit ? Math.max(2, Math.round((b.h - 1.5) / 3.1)) : 3 + Math.floor(R(1) * 2);
  const fh = 3.1;
  const W = floors * fh;
  const wallC = shade(pick(PAL.aptWall, R(2)), 0.97 + 0.06 * R(3));
  const row = R(4) < 0.5 ? 'upper' : 'modern';
  for (const ring of rings) {
    eachEdge(ring, (ax, ay, bx, by, len) => {
      const n = Math.max(1, Math.round(len / 5));
      for (let f = 0; f < floors; f++) G.wall(ax, ay, bx, by, f * fh, (f + 1) * fh, len > 3 ? row : 'solid', 0, n, f === 0 ? shade(wallC, 0.84) : wallC, wallC);
    });
  }
  const roofC = pick(PAL.roofTin, R(5));
  const ok = rings.length === 1 && R(6) < 0.6 && hipRoof(G, simp, W, { pitch: 0.32, eave: 0.6, roofC, roofRow: 'tin', fasciaC: PAL.fascia[0], maxRise: 4 });
  if (!ok) {
    for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, W, W + 0.9, 'solid', 0, 1, wallC, shade(wallC, 1.05)));
    flatRoof(G, rings, W, 0.9, pick(PAL.flatRoof, R(7)), wallC, R, B.A > 300 ? 2 : 1);
  }
}

function civic(G, B) {
  const { R, rings, simp, b, explicit } = B;
  const W = explicit ? Math.max(3.4, b.h * 0.72) : Math.max(3.6, Math.min(11, b.h * 0.62));
  const floors = Math.max(1, Math.round(W / 3.8));
  const fh = W / floors;
  const wallC = pick(PAL.civicWall, R(2));
  for (const ring of rings) {
    eachEdge(ring, (ax, ay, bx, by, len) => {
      const n = Math.max(1, Math.round(len / 5.5));
      for (let f = 0; f < floors; f++) G.wall(ax, ay, bx, by, f * fh, (f + 1) * fh, len > 3 ? 'upper' : 'solid', 0, n, f === 0 ? shade(wallC, 0.84) : wallC, wallC);
    });
  }
  const roofC = pick(PAL.civicRoof, R(3));
  const tile = roofC === PAL.civicRoof[0] || roofC === PAL.civicRoof[2];
  const ok = rings.length === 1 && hipRoof(G, simp, W, { pitch: b.h >= 11 ? 0.75 : 0.5, eave: 0.5, roofC, roofRow: tile ? 'tile' : 'tin', fasciaC: PAL.fascia[1], maxRise: 7 });
  if (!ok) {
    for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, W, W + 0.8, 'solid', 0, 1, wallC, wallC));
    flatRoof(G, rings, W, 0.8, pick(PAL.flatRoof, R(4)), wallC, R, 1);
  }
}

function industrial(G, B, env, small) {
  const { R, rings, simp, A, b, bi, explicit } = B;
  let W;
  if (explicit) W = Math.max(2.4, b.h * 0.85);
  else if (small) W = 2.3 + 0.7 * R(1);
  else W = A < 300 ? 3.6 + R(1) : A < 1500 ? 4.8 + 1.6 * R(1) : 6 + 2.5 * R(1);
  const wallC = shade(pick(PAL.indWall, R(2)), 0.96 + 0.06 * R(3));
  const roofC = small && R(4) < 0.5 ? pick(PAL.roofTin, R(5)) : pick(PAL.indRoof, R(5));
  const bot = shade(wallC, 0.84);
  // roller doors on street-facing walls (or the longest wall)
  let doorEdge = -1, longest = 0;
  eachEdge(rings[0], (ax, ay, bx, by, len, nx, ny, i) => { if (len > longest) { longest = len; doorEdge = i; } });
  rings.forEach((ring, ri) => {
    eachEdge(ring, (ax, ay, bx, by, len, nx, ny, i) => {
      const ed = ri === 0 && !small ? env.edge(ax, ay, bx, by, nx, ny, bi) : { type: 'side' };
      const doors = ri === 0 && !small && len >= 8 && ed.type !== 'party' && (ed.type === 'street' || i === doorEdge);
      const n = Math.max(1, Math.round(len / 6));
      if (!doors) { G.wall(ax, ay, bx, by, 0, W, 'clad', 0, n, bot, wallC); return; }
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const dh = Math.min(W, 5.5);
      for (let j = 0; j < n; j++) {
        const s0 = (len * j) / n, s1 = (len * (j + 1)) / n;
        const x0 = ax + dx * s0, y0 = ay + dy * s0, x1 = ax + dx * s1, y1 = ay + dy * s1;
        const door = (j + (n > 2 ? 1 : 0)) % 2 === 0 || n === 1;
        if (door) {
          G.wall(x0, y0, x1, y1, 0, dh, 'door', 0, 1, bot, shade(wallC, 0.84 + 0.16 * dh / W), 0, dh / 5.5);
          if (W > dh) G.wall(x0, y0, x1, y1, dh, W, 'clad', 0, 1, shade(wallC, 0.84 + 0.16 * dh / W), wallC);
        } else G.wall(x0, y0, x1, y1, 0, W, 'clad', 0, 1, bot, wallC);
      }
    });
  });
  const pitch = small ? 0.2 : 0.1;
  if (rings.length === 1 && nearRect(simp)) { gableRoof(G, simp, W, { pitch, eave: small ? 0.25 : 0.3, roofC, wallC, wallRow: 'clad' }); return; }
  const ok = rings.length === 1 && hipRoof(G, simp, W, { pitch, eave: 0.3, roofC, roofRow: 'tin', fasciaC: shade(wallC, 0.95), maxRise: 2.5 });
  if (!ok) {
    for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, W, W + 0.6, 'solid', 0, 1, wallC, wallC));
    flatRoof(G, rings, W, 0.6, roofC, wallC, R, A > 600 ? 2 : 0);
  }
}

function canopy(G, B) {
  const { R, rings, b } = B;
  const h = Math.max(2.5, b.h), base = h - 0.45;
  const c = pick(PAL.canopy, R(1)), top = pick(PAL.canopyRoof, R(2));
  for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, base, h, 'solid', 0, 1, c, c));
  G.flat(rings, h, top);
  G.flat(rings, base, shade(c, 0.95), true);
}

function round(G, B) {
  const { R, rings, b } = B;
  const h = Math.max(2.5, b.h);
  const c = pick(b.k === 6 ? PAL.silo : b.k === 7 ? PAL.tank : PAL.tower, R(1));
  for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, 0, h, 'solid', 0, 1, shade(c, 0.85), c));
  const ring = rings[0];
  if (ring.length >= 8 && b.k !== 8) {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    cx /= ring.length; cy /= ring.length;
    let r = 0;
    for (const p of ring) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cy));
    const apex = [cx, h + r * (b.k === 6 ? 0.35 : 0.15), -cy];
    const sv = [0, G.rows.solid[0]];
    const rc = shade(c, 1.04);
    eachEdge(ring, (ax, ay, bx, by, len, nx, ny) => {
      G.tri([ax, h, -ay], [bx, h, -by], apex, rc, rc, rc, sv, sv, sv, [nx, 1, -ny]);
    });
  } else G.flat(rings, h, shade(c, 1.04));
}

function plainBox(G, B) {
  const { rings, b } = B;
  const h = Math.max(2.5, b.h), c = PAL.shopWall[0];
  for (const ring of rings) eachEdge(ring, (ax, ay, bx, by) => G.wall(ax, ay, bx, by, 0, h, 'solid', 0, 1, shade(c, 0.85), c));
  G.flat(rings, h, PAL.flatRoof[0]);
}

function building(G, env, b, bi) {
  const rings = [toPts(b.p), ...(b.i || []).map(toPts)];
  let cx = 0, cy = 0;
  for (let i = 0; i < b.p.length; i += 2) { cx += b.p[i]; cy += b.p[i + 1]; }
  cx /= b.p.length / 2; cy /= b.p.length / 2;
  G.at(cx, cy);
  const A = Math.abs(ringArea(rings[0]));
  const R = seeded(cx, cy);
  const explicit = !(DEFAULT_H[b.k] || [5]).includes(b.h);
  const simp = simplifyRing(rings[0], 0.45);
  const B = { b, bi, rings, simp, A, R, explicit };
  const cbd = cbdness(cx, cy);
  const k = b.k;
  try {
    if (k === 4) return canopy(G, B);
    if (k === 6 || k === 7 || k === 8) return round(G, B);
    if (k === 5) return industrial(G, B, env, true);
    if (k === 2) return industrial(G, B, env, A < 60);
    if (k === 3) return civic(G, B);
    if (k === 1) return A < 35 ? industrial(G, B, env, true) : shop(G, B, env);
    // kind 0: house / residential / 'yes'
    if (explicit && b.h >= 8) return apartments(G, B);
    if (!explicit && b.h === 12) return apartments(G, B);
    if (A < 35) return industrial(G, B, env, true);
    const houseTag = !explicit && (b.h === 4.5 || b.h === 4.2);
    if (!houseTag && cbd > R(20)) return A < 60 ? industrial(G, B, env, true) : shop(G, B, env);
    if (explicit) return house(G, B, { W: Math.max(2.6, Math.min(7, b.h * 0.62)), storeys: b.h >= 6.5 ? 2 : 1 });
    if (b.h === 6) return house(G, B, { storeys: 2 });
    if (!houseTag && A >= 1500) return industrial(G, B, env, false);
    if (A >= 450) {
      // schools, units, clubs, retirement homes: bigger, lower-pitched
      return house(G, B, { W: 3.1 + 0.6 * R(30), storeys: 1, pitch: 0.3, tileChance: 0.3, solarChance: 0.5, maxRise: 3.2, tileW: 4.8 });
    }
    const two = A > 140 && A < 420 && R(31) < 0.1;
    return house(G, B, { storeys: two ? 2 : 1 });
  } catch (e) {
    G.fail = (G.fail || 0) + 1;
    plainBox(G, B);
  }
}

// Build all building meshes into world.group. Returns the triangle count.
export function addBuildings(world, buildings) {
  if (!world.buildingMaterial) {
    const { tex, rows } = buildAtlas();
    world.buildingMaterial = buildingMaterial(tex);
    world.buildingRows = rows;
  }
  const G = new Geo(world.buildingRows);
  const env = new Env(world.data, buildings);
  buildings.forEach((b, bi) => building(G, env, b, bi));
  for (const o of G.chunks.values()) {
    if (!o.p.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.p), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(o.n), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(o.c), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(o.t), 2));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, world.buildingMaterial);
    m.matrixAutoUpdate = false;
    m.castShadow = m.receiveShadow = true;
    world.group.add(m);
  }
  world.stats.buildingTris = G.tris;
  world.stats.buildingFallbacks = G.fail || 0;
  return G.tris;
}
