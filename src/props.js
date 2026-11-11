// Street-level props: trees, street lights, traffic signals, crossings, bus
// stops, benches and other furniture, fences / walls / hedges, power lines,
// playground equipment and car-park bay markings.
//
// Positions come from the map build (tools/build-map.mjs, "street props"),
// which places real OpenStreetMap features where they are mapped and fills in
// street lights / playground kit procedurally, keeping everything off the
// carriageways. Here they are turned into low-poly, vertex-coloured geometry
// that is merged into the world's per-tile object meshes (no extra draw
// calls), and thin flat markings on the ground layers. Fully deterministic.
//
// Map frame: x = east, y = north; a map point (x, y) at height h is world
// (x, h, -y). Angles are map-frame radians (0 = east, counter-clockwise).

import * as THREE from 'three';
import { L, TILE } from './world.js';

const col = (hex) => new THREE.Color(hex);
const D2R = Math.PI / 180;

function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
const hxy = (x, y, s = 0) => hash((Math.round(x * 10) * 73856093) ^ (Math.round(y * 10) * 19349663) ^ (s * 83492791));

const P = {
  steel: col(0x9ba1a5), steelDark: col(0x5d6266), lampHead: col(0x4f5458), lampGlow: col(0xfff3cf),
  signalPole: col(0x6f7579), signalHead: col(0x1e2023), red: col(0xd2372b), amber: col(0xe2a524), green: col(0x3fc46a),
  white: col(0xf0f0ea), timber: col(0x9a6b44), timberDark: col(0x6e4b31), binGreen: col(0x2f5d3a), postRed: col(0xc4232c),
  cabinet: col(0x9ca79c), brick: col(0xa9705a), concrete: col(0xb9b4a9), hedge: col(0x4d7a3a), fence: col(0x8e9497),
  fenceTimber: col(0x8c7357), glass: col(0x8fb2bf), roofGrey: col(0xc9ccca), stopGreen: col(0x2e7a49), stopYellow: col(0xf0c419),
  pole: col(0x7a6a58), tower: col(0x9aa1a6), wire: col(0x3a3d40), flagBlue: col(0x24418f),
  playRed: col(0xd2462f), playYellow: col(0xf1c232), playBlue: col(0x2f78c4), playGreen: col(0x4caf50), bark: col(0x6b5340),
};

// ------------------------------------------------------------------ emitters
function quad(w, o, a, b, c, d, nrm, color) { w.tri3(o, a, b, c, nrm, color); w.tri3(o, a, c, d, nrm, color); }

// oriented box centred on (x, y): lx along `ang`, ly across, from h0 to h1
function box(w, o, x, y, ang, lx, ly, h0, h1, color, top = color, bottom = null) {
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux, hx = lx / 2, hy = ly / 2;
  const Q = (su, sv, h) => [x + ux * hx * su + vx * hy * sv, h, -(y + uy * hx * su + vy * hy * sv)];
  quad(w, o, Q(1, -1, h0), Q(1, 1, h0), Q(1, 1, h1), Q(1, -1, h1), [ux, 0, -uy], color);
  quad(w, o, Q(-1, -1, h0), Q(-1, 1, h0), Q(-1, 1, h1), Q(-1, -1, h1), [-ux, 0, uy], color);
  quad(w, o, Q(-1, 1, h0), Q(1, 1, h0), Q(1, 1, h1), Q(-1, 1, h1), [vx, 0, -vy], color);
  quad(w, o, Q(-1, -1, h0), Q(1, -1, h0), Q(1, -1, h1), Q(-1, -1, h1), [-vx, 0, vy], color);
  if (top) quad(w, o, Q(-1, -1, h1), Q(1, -1, h1), Q(1, 1, h1), Q(-1, 1, h1), [0, 1, 0], top);
  if (bottom) quad(w, o, Q(-1, -1, h0), Q(1, -1, h0), Q(1, 1, h0), Q(-1, 1, h0), [0, -1, 0], bottom);
}

// square-section bar between two world points (no end caps)
function beam(w, o, A, B, r, color) {
  const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / l, dy / l, dz / l];
  // any vector not parallel to d
  const t = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  const l1 = Math.hypot(...e1); e1 = e1.map((v) => v / l1);
  const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
  const off = (P, a, b) => [P[0] + (e1[0] * a + e2[0] * b) * r, P[1] + (e1[1] * a + e2[1] * b) * r, P[2] + (e1[2] * a + e2[2] * b) * r];
  const c = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const n = [e1[0] * mx + e2[0] * my, e1[1] * mx + e2[1] * my, e1[2] * mx + e2[2] * my];
    quad(w, o, off(A, ...a), off(A, ...b), off(B, ...b), off(B, ...a), n, color);
  }
}

// vertical n-sided (tapered) prism, optional top cap
function prism(w, o, x, y, n, r0, r1, h0, h1, color, rot = 0, top = null) {
  const slope = (r0 - r1) / Math.max(0.01, h1 - h0);
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    quad(w, o, [x + c0 * r0, h0, -(y + s0 * r0)], [x + c1 * r0, h0, -(y + s1 * r0)], [x + c1 * r1, h1, -(y + s1 * r1)], [x + c0 * r1, h1, -(y + s0 * r1)], [Math.cos(am), slope, -Math.sin(am)], color);
    if (top) w.tri3(o, [x, h1, -y], [x + c0 * r1, h1, -(y + s0 * r1)], [x + c1 * r1, h1, -(y + s1 * r1)], [0, 1, 0], top);
  }
}

// cone (n sides) from a disc at h0 to an apex at h1, optional underside
function cone(w, o, x, y, n, r, h0, h1, color, rot = 0, under = null) {
  const slope = r / Math.max(0.01, h1 - h0);
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const A = [x + Math.cos(a0) * r, h0, -(y + Math.sin(a0) * r)], B = [x + Math.cos(a1) * r, h0, -(y + Math.sin(a1) * r)];
    w.tri3(o, A, B, [x, h1, -y], [Math.cos(am), slope, -Math.sin(am)], color);
    if (under) w.tri3(o, A, B, [x, h0, -y], [0, -1, 0], under);
  }
}

// a polyhedron (non-indexed unit positions) scaled sx/sy and shaded by facing
const SOLIDS = {};
const solid = (name) => SOLIDS[name] || (SOLIDS[name] = (name === 'ico' ? new THREE.IcosahedronGeometry(1, 0) : new THREE.OctahedronGeometry(1, 0)).attributes.position.array);
function blob(w, o, x, y, cy, sx, sy, g, rot, name = 'ico') {
  const ip = solid(name);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = 0; i < ip.length; i += 9) {
    const v = [];
    for (let q = 0; q < 3; q++) {
      const px = ip[i + q * 3], py = ip[i + q * 3 + 1], pz = ip[i + q * 3 + 2];
      v.push([x + (px * cr - pz * sr) * sx, cy + py * sy, -y + (px * sr + pz * cr) * sx]);
    }
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // faces point away from the centre
    const mx = (v[0][0] + v[1][0] + v[2][0]) / 3 - x, my = (v[0][1] + v[1][1] + v[2][1]) / 3 - cy, mz = (v[0][2] + v[1][2] + v[2][2]) / 3 + y;
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    w.tri3(o, v[0], v[1], v[2], [nx, ny, nz], g.clone().multiplyScalar(0.85 + 0.25 * Math.max(0, ny)));
  }
}

// ------------------------------------------------------------------ trees
// kinds: 0 broadleaf (generic), 1 eucalypt, 2 peppermint (Agonis), 3 Norfolk
// Island pine, 4 palm. `k` is a per-tree seed.
const GREENS = [0x5d7f3c, 0x6c8f4a, 0x4f7036, 0x7a9450, 0x587a46].map(col);
const GUM = [0x7f9460, 0x8d9d68, 0x6e8655, 0x93a26f].map(col);
const PEPPER = [0x4f7038, 0x58793f, 0x4a6834].map(col);
const PINE = [0x2f5a37, 0x34613b, 0x2b5232].map(col);
const PALM = [0x5f8a3c, 0x6a9443].map(col);
const TRUNK = col(0x6b5340), GUM_BARK = col(0xd3cab6), PINE_BARK = col(0x6d5947), PALM_BARK = col(0x8a7b66);
const TREE_R = [0.55, 0.45, 0.4, 0.5, 0.3];

export function addTree(w, x, y, s, kind, k) {
  const o = w.obj(x, y);
  const rot = hash(k + 5) * 6.28;
  if (kind === 1) {
    // eucalypt: tall pale trunk, open crown high up in two clumps
    const g = GUM[Math.floor(hash(k + 11) * GUM.length)];
    const th = 6.2 * s;
    prism(w, o, x, y, 4, 0.3 * s, 0.15 * s, 0, th, GUM_BARK, rot);
    const ox = Math.cos(rot) * 0.6 * s, oy = Math.sin(rot) * 0.6 * s;
    blob(w, o, x + ox, y + oy, th + 0.7 * s, 2.4 * s, 1.6 * s, g, rot);
    blob(w, o, x - ox * 1.4, y - oy * 1.4, th + 1.2 * s, 1.9 * s, 1.4 * s, g.clone().multiplyScalar(1.07), rot + 1, 'oct');
  } else if (kind === 2) {
    // peppermint: short dark trunk, broad low weeping crown
    const g = PEPPER[Math.floor(hash(k + 11) * PEPPER.length)];
    prism(w, o, x, y, 4, 0.26 * s, 0.16 * s, 0, 2.4 * s, TRUNK, rot);
    blob(w, o, x, y, 3.3 * s, 3.0 * s, 1.85 * s, g, rot);
  } else if (kind === 3) {
    // Norfolk Island pine: tall straight trunk with flat, gapped tiers
    const g = PINE[Math.floor(hash(k + 11) * PINE.length)];
    const under = g.clone().multiplyScalar(0.7);
    prism(w, o, x, y, 4, 0.38 * s, 0.08 * s, 0, 17 * s, PINE_BARK, rot);
    for (let i = 0; i < 4; i++) {
      const h = (4.6 + i * 3.0) * s, r = (3.0 - i * 0.6) * s;
      cone(w, o, x, y, 6, r, h, h + 1.7 * s, g, rot + i * 0.5, under);
    }
    cone(w, o, x, y, 5, 0.75 * s, 16.4 * s, 19 * s, g, rot);
  } else if (kind === 4) {
    // palm: slim leaning trunk, a crown of drooping fronds
    const lx = Math.cos(rot) * 0.35 * s, ly = Math.sin(rot) * 0.35 * s;
    const A = [x, 0, -y], B = [x + lx, 4.6 * s, -(y + ly)], C = [x + 2.2 * lx, 9.2 * s, -(y + 2.2 * ly)];
    beam(w, o, A, B, 0.24 * s, PALM_BARK);
    beam(w, o, B, C, 0.19 * s, PALM_BARK);
    const g = PALM[Math.floor(hash(k + 11) * PALM.length)], gu = g.clone().multiplyScalar(0.72);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2 + hash(k + i) * 0.4;
      const ca = Math.cos(a), sa = -Math.sin(a), px = -sa, pz = ca; // world dir (ca, 0, sa) and its side
      const mid = [C[0] + ca * 1.7 * s, C[1] + 0.45 * s, C[2] + sa * 1.7 * s];
      const tip = [C[0] + ca * 3.4 * s, C[1] - 1.1 * s, C[2] + sa * 3.4 * s];
      const wd = 0.5 * s;
      const mL = [mid[0] + px * wd, mid[1], mid[2] + pz * wd], mR = [mid[0] - px * wd, mid[1], mid[2] - pz * wd];
      for (const [p0, p1, p2, up] of [[C, mL, mR, [ca * -0.3, 1, sa * -0.3]], [mL, tip, mR, [ca * 0.6, 1, sa * 0.6]]]) {
        w.tri3(o, p0, p1, p2, up, g);
        w.tri3(o, p0, p1, p2, [-up[0], -up[1], -up[2]], gu);
      }
    }
    blob(w, o, C[0], -C[2], C[1] - 0.1 * s, 0.55 * s, 0.5 * s, PALM_BARK.clone().multiplyScalar(0.9), rot, 'oct');
  } else {
    // generic broadleaf (the original park / wood tree)
    const g = GREENS[Math.floor(hash(k + 11) * GREENS.length)];
    const sx = 2.4 * s, sy = 2.1 * s, cy = 3.4 * s;
    blob(w, o, x, y, cy, sx, sy, g, rot);
    const tr = 0.22 * s + 0.08, th = cy - sy * 0.5;
    prism(w, o, x, y, 3, tr, tr, 0, th, TRUNK, rot);
  }
  w.addColCircle(x, y, TREE_R[kind] || 0.55);
}

// ------------------------------------------------------------------ street lights
// style 0: arterial (9.5 m, long arm), 1: residential (7.5 m), 2: mapped
function lamp(w, x, y, a, style) {
  const o = w.obj(x, y);
  const H = style === 1 ? 7.5 : 9.5, A = style === 1 ? 1.2 : 1.9;
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  // 22 triangles: 3-sided pole, open arm (top + sides), luminaire box
  prism(w, o, x, y, 3, 0.12, 0.08, 0, H + 0.05, P.steel, a + Math.PI);
  const hw = 0.045, Q = (u, v, h) => [x + ux * u + vx * v, h, -(y + uy * u + vy * v)];
  quad(w, o, Q(0, -hw, H), Q(A, -hw, H), Q(A, hw, H), Q(0, hw, H), [0, 1, 0], P.steel);
  for (const s of [-1, 1]) quad(w, o, Q(0, s * hw, H - 0.1), Q(A, s * hw, H - 0.1), Q(A, s * hw, H), Q(0, s * hw, H), [vx * s, 0, -vy * s], P.steel);
  const u0 = A - 0.15, u1 = A + 0.6, b = 0.15, h0 = H - 0.24, h1 = H - 0.02;
  quad(w, o, Q(u0, -b, h1), Q(u1, -b, h1), Q(u1, b, h1), Q(u0, b, h1), [0, 1, 0], P.lampHead);
  quad(w, o, Q(u0, -b, h0), Q(u1, -b, h0), Q(u1, b, h0), Q(u0, b, h0), [0, -1, 0], P.lampGlow);
  for (const s of [-1, 1]) quad(w, o, Q(u0, s * b, h0), Q(u1, s * b, h0), Q(u1, s * b, h1), Q(u0, s * b, h1), [vx * s, 0, -vy * s], P.lampHead);
  quad(w, o, Q(u1, -b, h0), Q(u1, b, h0), Q(u1, b, h1), Q(u1, -b, h1), [ux, 0, -uy], P.lampHead);
  w.addColCircle(x, y, 0.15);
}

// ------------------------------------------------------------------ traffic signals
// a pole at the kerb with a three-aspect head facing the approaching traffic
function signal(w, x, y, a) {
  const o = w.obj(x, y);
  const ux = Math.cos(a), uy = Math.sin(a);
  prism(w, o, x, y, 4, 0.1, 0.08, 0, 4.0, P.signalPole, a + Math.PI / 4, P.signalPole);
  const hx = x + ux * 0.22, hy = y + uy * 0.22;
  box(w, o, hx, hy, a, 0.28, 0.4, 2.55, 3.75, P.signalHead, P.signalHead, P.signalHead);
  // lenses on the face (the face looks along +a)
  const fx = hx + ux * 0.145, fy = hy + uy * 0.145, vx = -uy, vy = ux, r = 0.12;
  const lens = (h, c) => {
    const Q = (sv, dh) => [fx + vx * r * sv, h + dh, -(fy + vy * r * sv)];
    quad(w, o, Q(-1, -r), Q(1, -r), Q(1, r), Q(-1, r), [ux, 0, -uy], c);
  };
  lens(3.47, P.red); lens(3.15, P.amber); lens(2.83, P.green);
  // a second head on the back of the pole for the far side of the junction
  box(w, o, x - ux * 0.2, y - uy * 0.2, a, 0.24, 0.36, 2.7, 3.7, P.signalHead, P.signalHead);
  w.addColCircle(x, y, 0.15);
}

// ------------------------------------------------------------------ crossings (flat markings)
function crossing(w, x, y, a, width, type) {
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const R = (u0, v0, u1, v1) => [[x + ux * u0 + vx * v0, y + uy * u0 + vy * v0], [x + ux * u1 + vx * v0, y + uy * u1 + vy * v0], [x + ux * u1 + vx * v1, y + uy * u1 + vy * v1], [x + ux * u0 + vx * v1, y + uy * u0 + vy * v1]];
  const hw = width / 2 - 0.3;
  if (hw < 1) return 0;
  if (type === 0) {
    // zebra: bars along the road, spaced across it
    const n = Math.max(2, Math.floor((2 * hw + 0.5) / 1.1));
    const span = n * 1.1 - 0.5, v0 = -span / 2;
    for (let i = 0; i < n; i++) w.convex(L.marking, R(-1.6, v0 + i * 1.1, 1.6, v0 + i * 1.1 + 0.6), P.white);
  } else {
    // signalised: two lines across the road
    for (const u of [-1.5, 1.5]) w.convex(L.marking, R(u - 0.15, -hw, u + 0.15, hw), P.white);
  }
  return 1;
}

// ------------------------------------------------------------------ bus stops
function busStop(w, x, y, a, shelter) {
  const o = w.obj(x, y);
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux; // a: towards the road
  // flag pole at the kerb end of the stop
  const px = x + ux * 0.6 + vx * 2.2, py = y + uy * 0.6 + vy * 2.2;
  prism(w, o, px, py, 4, 0.05, 0.05, 0, 2.7, P.steel, a);
  box(w, o, px, py, a + Math.PI / 2, 0.5, 0.05, 2.0, 2.65, P.stopGreen, P.stopYellow);
  if (!shelter) return;
  const L0 = 3.4, D = 1.5, H = 2.35;
  const bx = x - ux * D / 2, by = y - uy * D / 2;
  box(w, o, bx, by, a + Math.PI / 2, L0, 0.06, 0.15, H, P.glass, P.steel);
  for (const sd of [-1, 1]) {
    box(w, o, x + vx * sd * L0 / 2, y + vy * sd * L0 / 2, a, D, 0.06, 0.15, H, P.glass, P.steel);
    box(w, o, x + vx * sd * L0 / 2 + ux * D / 2, y + vy * sd * L0 / 2 + uy * D / 2, a, 0.08, 0.08, 0, H, P.steel);
  }
  box(w, o, x, y, a, D + 0.3, L0 + 0.2, H, H + 0.12, P.roofGrey, P.roofGrey, P.roofGrey);
  // bench along the back panel
  box(w, o, x - ux * (D / 2 - 0.3), y - uy * (D / 2 - 0.3), a + Math.PI / 2, L0 - 0.6, 0.38, 0.4, 0.47, P.timber);
  const B0 = [bx - vx * L0 / 2, by - vy * L0 / 2], B1 = [bx + vx * L0 / 2, by + vy * L0 / 2];
  w.addColSeg(B0[0], B0[1], B1[0], B1[1]);
}

// ------------------------------------------------------------------ furniture
// kinds as FURN in build-map.mjs
function furniture(w, x, y, kind, a) {
  const o = w.obj(x, y);
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux; // a: the direction it faces
  const side = a + Math.PI / 2;
  switch (kind) {
    case 0: { // bench
      box(w, o, x, y, side, 1.8, 0.45, 0.42, 0.48, P.timber);
      box(w, o, x - ux * 0.22, y - uy * 0.22, side, 1.8, 0.06, 0.52, 0.86, P.timber);
      for (const sd of [-0.75, 0.75]) box(w, o, x + vx * sd, y + vy * sd, side, 0.07, 0.45, 0, 0.42, P.steelDark);
      w.addColCircle(x, y, 0.3);
      break;
    }
    case 1: // waste basket
      prism(w, o, x, y, 6, 0.27, 0.3, 0, 0.95, P.binGreen, a, P.steelDark);
      w.addColCircle(x, y, 0.3);
      break;
    case 2: { // picnic table with bench seats
      box(w, o, x, y, side, 1.9, 0.8, 0.72, 0.78, P.timber);
      for (const sd of [-0.68, 0.68]) box(w, o, x + ux * sd, y + uy * sd, side, 1.9, 0.26, 0.42, 0.47, P.timber);
      for (const sd of [-0.7, 0.7]) box(w, o, x + vx * sd, y + vy * sd, a, 1.5, 0.08, 0, 0.72, P.timberDark);
      w.addColCircle(x, y, 0.8);
      break;
    }
    case 3: // barbecue
      box(w, o, x, y, side, 1.3, 0.75, 0, 0.88, P.brick, P.steelDark);
      w.addColCircle(x, y, 0.55);
      break;
    case 4: // post box
      box(w, o, x, y, a, 0.45, 0.5, 0, 1.15, P.postRed);
      prism(w, o, x, y, 4, 0.33, 0.12, 1.15, 1.3, P.postRed, a + Math.PI / 4, P.postRed);
      w.addColCircle(x, y, 0.3);
      break;
    case 5: // street cabinet
      box(w, o, x, y, side, 0.9, 0.45, 0, 1.3, P.cabinet);
      w.addColCircle(x, y, 0.4);
      break;
    case 6: // drinking fountain
      prism(w, o, x, y, 5, 0.16, 0.13, 0, 0.95, P.concrete, a, P.steel);
      break;
    case 7: { // bike rack: three hoops
      for (const sd of [-0.8, 0, 0.8]) {
        const cx = x + vx * sd, cy = y + vy * sd;
        const A = [cx - ux * 0.35, 0, -(cy - uy * 0.35)], B = [cx + ux * 0.35, 0, -(cy + uy * 0.35)];
        const A1 = [A[0], 0.8, A[2]], B1 = [B[0], 0.8, B[2]];
        beam(w, o, A, A1, 0.03, P.steel); beam(w, o, B, B1, 0.03, P.steel); beam(w, o, A1, B1, 0.03, P.steel);
      }
      break;
    }
    case 8: // information board
      for (const sd of [-0.55, 0.55]) prism(w, o, x + vx * sd, y + vy * sd, 4, 0.05, 0.05, 0, 1.9, P.timberDark, a);
      box(w, o, x, y, side, 1.3, 0.07, 1.0, 1.9, P.timberDark, P.timberDark);
      w.addColCircle(x, y, 0.3);
      break;
    case 9: { // fitness station: two posts and a bar
      for (const sd of [-0.9, 0.9]) prism(w, o, x + vx * sd, y + vy * sd, 4, 0.07, 0.07, 0, 2.1, P.steel, a);
      beam(w, o, [x - vx * 0.9, 2.05, -(y - vy * 0.9)], [x + vx * 0.9, 2.05, -(y + vy * 0.9)], 0.035, P.steel);
      break;
    }
    case 10: // flagpole
      prism(w, o, x, y, 4, 0.07, 0.04, 0, 9, P.white, a);
      box(w, o, x + Math.cos(a) * 0.65, y + Math.sin(a) * 0.65, a, 1.25, 0.03, 7.7, 8.5, P.flagBlue);
      w.addColCircle(x, y, 0.12);
      break;
    default:
  }
}

// ------------------------------------------------------------------ fences, walls, hedges
// kinds as FENCE in build-map.mjs: 0 fence, 1 wall, 2 retaining wall, 3 hedge, 4 guard rail, 5 chain link
function fence(w, p, k) {
  if (k === 1) w.wall3(p, 0.25, 1.7, P.brick);
  else if (k === 2) w.wall3(p, 0.35, 0.9, P.concrete);
  else if (k === 3) w.wall3(p, 0.9, 1.4, P.hedge);
  else {
    const h = k === 4 ? 0.75 : 1.8, c = k === 0 ? P.fenceTimber : P.fence, sp = k === 4 ? 2 : 3;
    // posts, a top rail and (for fences) a mid rail
    const n = p.length / 2;
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      let s = (sp - acc) % sp;
      for (; s <= len; s += sp) {
        const o = w.obj(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len);
        prism(w, o, ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len, 4, 0.05, 0.05, 0, h, c, Math.PI / 4);
      }
      acc = (acc + len) % sp;
    }
    const e = w.obj(p[2 * n - 2], p[2 * n - 1]);
    prism(w, e, p[2 * n - 2], p[2 * n - 1], 4, 0.05, 0.05, 0, h, c, Math.PI / 4);
    w.wall3(p, 0.06, h, c, h - 0.1);
    w.wall3(p, 0.05, k === 4 ? 0.45 : 0.95, c, k === 4 ? 0.3 : 0.88);
  }
  for (let i = 0; i < p.length - 2; i += 2) w.addColSeg(p[i], p[i + 1], p[i + 2], p[i + 3]);
}

// ------------------------------------------------------------------ power
function tower(w, x, y, a) {
  const o = w.obj(x, y);
  const H = 27, B = 2.4, T = 0.7;
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const corner = (su, sv, r, h) => [x + (ux * su + vx * sv) * r, h, -(y + (uy * su + vy * sv) * r)];
  const cs = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [su, sv] of cs) beam(w, o, corner(su, sv, B, 0), corner(su, sv, T, H), 0.12, P.tower);
  // bracing rings and diagonals on two faces
  for (const h of [8, 16]) {
    const r = B + (T - B) * (h / H);
    for (let i = 0; i < 4; i++) beam(w, o, corner(...cs[i], r, h), corner(...cs[(i + 1) % 4], r, h), 0.06, P.tower);
  }
  for (const sd of [1, -1]) beam(w, o, corner(1, sd, B, 0), corner(-1, sd, B + (T - B) * (8 / H), 8), 0.05, P.tower);
  // cross-arms for the three conductors (along u, perpendicular to the line)
  for (const [h, half] of [[20.5, 3.6], [24.5, 2.6]]) box(w, o, x, y, a, half * 2, 0.35, h - 0.35, h, P.tower, P.tower, P.tower);
  cone(w, o, x, y, 4, T * 1.2, H, H + 2.5, P.tower, a + Math.PI / 4);
  w.addColCircle(x, y, 2.4);
}

function pole(w, x, y) {
  const o = w.obj(x, y);
  const a = hxy(x, y, 3) * Math.PI;
  prism(w, o, x, y, 5, 0.15, 0.11, 0, 10, P.pole, a, P.pole);
  box(w, o, x, y, a, 2.2, 0.1, 9.05, 9.2, P.pole, P.pole, P.pole);
  w.addColCircle(x, y, 0.18);
}

// conductors between consecutive vertices, sagging (thin crossed ribbons)
function powerLine(w, v) {
  const n = v.length / 3;
  for (let i = 0; i < n - 1; i++) {
    const ax = v[3 * i], ay = v[3 * i + 1], ah = v[3 * i + 2], bx = v[3 * i + 3], by = v[3 * i + 4], bh = v[3 * i + 5];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
    const sag = Math.min(5, len * 0.03);
    // three conductors: [lateral offset, height] at a tower's cross-arm tips or a pole's cross-arm
    const att = (h) => (h > 15 ? [[-3.45, 20.1], [3.45, 20.1], [2.45, 24.1]] : [[-1.0, 9.25], [1.0, 9.25], [0.3, 9.25]]);
    const ta = att(ah), tb = att(bh);
    for (let c = 0; c < 3; c++) {
      const ha = ta[c][1], hb = tb[c][1];
      const SEG = 8;
      let prev = null;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG, off = ta[c][0] + (tb[c][0] - ta[c][0]) * t;
        const x = ax + (bx - ax) * t + nx * off, y = ay + (by - ay) * t + ny * off;
        const h = ha + (hb - ha) * t - sag * 4 * t * (1 - t);
        const cur = [x, h, -y];
        if (prev) {
          const o = w.obj(x, y), r = 0.05;
          for (const sg of [1, -1]) {
            quad(w, o, [prev[0], prev[1] - r, prev[2]], [cur[0], cur[1] - r, cur[2]], [cur[0], cur[1] + r, cur[2]], [prev[0], prev[1] + r, prev[2]], [nx * sg, 0, -ny * sg], P.wire);
            quad(w, o, [prev[0] - nx * r, prev[1], prev[2] + ny * r], [cur[0] - nx * r, cur[1], cur[2] + ny * r], [cur[0] + nx * r, cur[1], cur[2] - ny * r], [prev[0] + nx * r, prev[1], prev[2] - ny * r], [0, sg, 0], P.wire);
          }
        }
        prev = cur;
      }
    }
  }
}

// ------------------------------------------------------------------ playgrounds
// kinds as PLAYK in build-map.mjs
function play(w, x, y, kind, a) {
  const o = w.obj(x, y);
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const at = (u, v, h) => [x + ux * u + vx * v, h, -(y + uy * u + vy * v)];
  if (kind === 0 || kind === 3) {
    // fort: four posts, a deck, a pitched roof, a slide and a ladder
    const r = 0.9;
    for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) beam(w, o, at(su * r, sv * r, 0), at(su * r, sv * r, 2.7), 0.06, P.playBlue);
    box(w, o, x, y, a, 2 * r + 0.2, 2 * r + 0.2, 1.15, 1.3, P.playYellow, P.timber, P.timberDark);
    for (const sv of [-1, 1]) box(w, o, x + vx * sv * r, y + vy * sv * r, a, 2 * r, 0.05, 1.3, 1.95, P.playYellow);
    cone(w, o, x, y, 4, (r + 0.35) * 1.41, 2.7, 3.6, P.playRed, a + Math.PI / 4, P.playRed);
    if (kind === 0) {
      // slide off the +u side
      const s0 = at(r, 0, 1.25), s1 = at(r + 2.6, 0, 0.25);
      for (const sv of [-0.3, 0.3]) beam(w, o, at(r, sv, 1.35), at(r + 2.6, sv, 0.35), 0.04, P.playYellow);
      quad(w, o, [s0[0] - vx * 0.28, s0[1], s0[2] + vy * 0.28], [s1[0] - vx * 0.28, s1[1], s1[2] + vy * 0.28], [s1[0] + vx * 0.28, s1[1], s1[2] - vy * 0.28], [s0[0] + vx * 0.28, s0[1], s0[2] - vy * 0.28], [ux * 0.36, 1, -uy * 0.36], P.playGreen);
      // ladder on the -u side
      for (const sv of [-0.3, 0.3]) beam(w, o, at(-r - 0.9, sv, 0), at(-r, sv, 1.3), 0.04, P.playBlue);
    }
    w.addColCircle(x, y, 1.4);
  } else if (kind === 1) {
    for (const sv of [-0.3, 0.3]) beam(w, o, at(-1.2, sv, 0), at(-0.6, sv, 1.8), 0.04, P.playBlue);
    const s0 = at(-0.6, 0, 1.75), s1 = at(1.8, 0, 0.3);
    quad(w, o, [s0[0] - vx * 0.28, s0[1], s0[2] + vy * 0.28], [s1[0] - vx * 0.28, s1[1], s1[2] + vy * 0.28], [s1[0] + vx * 0.28, s1[1], s1[2] - vy * 0.28], [s0[0] + vx * 0.28, s0[1], s0[2] - vy * 0.28], [ux * 0.6, 1, -uy * 0.6], P.playYellow);
    w.addColCircle(x, y, 0.6);
  } else if (kind === 2) {
    // swing set: A-frames at both ends, a top beam, two seats
    const hl = 1.8;
    for (const su of [-hl, hl]) for (const sv of [-0.9, 0.9]) beam(w, o, at(su, sv, 0), at(su, 0, 2.4), 0.06, P.playRed);
    beam(w, o, at(-hl, 0, 2.4), at(hl, 0, 2.4), 0.07, P.playRed);
    for (const su of [-0.7, 0.7]) {
      for (const d of [-0.22, 0.22]) beam(w, o, at(su + d, 0, 2.4), at(su + d, 0, 0.55), 0.015, P.steelDark);
      box(w, o, x + ux * su, y + uy * su, a, 0.5, 0.22, 0.5, 0.56, P.signalHead);
    }
    for (const su of [-hl, hl]) w.addColCircle(x + ux * su, y + uy * su, 0.4);
  } else if (kind === 4) {
    prism(w, o, x, y, 4, 0.08, 0.08, 0, 0.35, P.steelDark, a);
    box(w, o, x, y, a, 0.7, 0.3, 0.35, 0.75, P.playGreen);
  } else if (kind === 5) {
    prism(w, o, x, y, 8, 1.1, 1.1, 0.15, 0.25, P.playRed, a, P.playYellow);
  }
}

// ------------------------------------------------------------------ car-park bays
// Bay divider lines in mapped car parks: rows of 2.6 m x 5 m bays across the
// car park's long axis, double rows between 6.5 m aisles; a line is kept only
// where it lies well inside the car park, clear of mapped roads / aisles and
// buildings. Purely derived from the polygons (no data stored).
function parkingBays(w) {
  let lines = 0;
  for (const poly of w.data.areas.parking || []) {
    const ring = poly[0], holes = poly.slice(1);
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
    if (Math.abs(area / 2) < 350) continue;
    // minimum-area bounding rectangle over the polygon edges
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (l < 3) continue;
      const ux = (p1[0] - p0[0]) / l, uy = (p1[1] - p0[1]) / l;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const q of pts) {
        const u = q[0] * ux + q[1] * uy, v = -q[0] * uy + q[1] * ux;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const ar = (u1 - u0) * (v1 - v0);
      if (!best || ar < best.ar) best = { ar, ux, uy, u0, u1, v0, v1 };
    }
    if (!best) continue;
    let { ux, uy, u0, u1, v0, v1 } = best;
    // rows run along the long side
    if (v1 - v0 > u1 - u0) { [ux, uy] = [-uy, ux]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
    const vx = -uy, vy = ux;
    const at = (u, v) => [ux * u + vx * v, uy * u + vy * v];
    const inside = (x, y) => pointInFlat(x, y, ring) && !holes.some((h) => pointInFlat(x, y, h));
    const clear = (x, y) => {
      const nr = w.nearestRoad(x, y, 6);
      if (nr && nr.dist < 0.8) return false;
      const cell = w.colGrid.get(Math.floor(x / w.CG) * 65536 + Math.floor(y / w.CG));
      if (cell) for (const b of cell.p) if (x >= b.bb[0] && x <= b.bb[2] && y >= b.bb[1] && y <= b.bb[3] && pointInFlat(x, y, b.p)) return false;
      return true;
    };
    // bands across v: single row, aisle, then double rows separated by aisles
    const bands = [];
    let v = v0 + 0.8, first = true;
    while (true) {
      const n = first ? 1 : 2;
      if (v + 5 * n > v1 - 0.8) { if (v + 5 <= v1 - 0.8) bands.push([v, v + 5]); break; }
      for (let i = 0; i < n; i++) bands.push([v + 5 * i, v + 5 * (i + 1)]);
      v += 5 * n + 6.5;
      first = false;
    }
    const phase = ((u0 % 2.6) + 2.6) % 2.6;
    for (const [b0, b1] of bands) {
      for (let u = u0 + 1.2 + (2.6 - phase); u <= u1 - 1.2; u += 2.6) {
        const test = [[u - 0.7, b0 - 0.2], [u + 0.7, b0 - 0.2], [u - 0.7, b1 + 0.2], [u + 0.7, b1 + 0.2], [u, (b0 + b1) / 2]];
        if (!test.every(([a, b]) => { const q = at(a, b); return inside(q[0], q[1]); })) continue;
        if (![[u, b0], [u, (b0 + b1) / 2], [u, b1]].every(([a, b]) => { const q = at(a, b); return clear(q[0], q[1]); })) continue;
        const A = at(u - 0.06, b0), B = at(u + 0.06, b0), C2 = at(u + 0.06, b1), D = at(u - 0.06, b1);
        w.convex(L.pitchMark, [A, B, C2, D], P.white);
        lines++;
      }
    }
  }
  return lines;
}

function pointInFlat(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ entry
// Called by World before the tile meshes are finished (needs the road grid).
export function addProps(w) {
  const pr = w.data.props;
  const tris0 = countObjTris(w);
  // Props are spread over many tiles that have no object mesh yet (a street
  // light alone would cost a draw call). Geometry is in world space, so in such
  // a tile it goes into an object mesh of the same 2x2 tile block instead
  // (only the culling gets coarser); w.obj is restored afterwards.
  const tileObj = w.obj;
  w.obj = (x, y) => {
    const T = TILE, ix = Math.floor(x / T), iy = Math.floor(y / T);
    const own = w.objs.get(w.tileKey(ix, iy));
    if (own) return own;
    const bx = ix - (((ix % 2) + 2) % 2), by = iy - (((iy % 2) + 2) % 2);
    for (const [jx, jy] of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]]) {
      const o = w.objs.get(w.tileKey(jx, jy));
      if (o) return o;
    }
    return tileObj.call(w, bx * T + 1, by * T + 1);
  };
  try { buildAll(w, pr); } finally { delete w.obj; } // back to World.prototype.obj
  w.stats.propTris = countObjTris(w) - tris0;
}

function buildAll(w, pr) {
  const n = { trees: 0, lamps: 0, signals: 0, crossings: 0, stops: 0, furniture: 0, fences: 0, towers: 0, poles: 0, lines: 0, play: 0, bays: 0 };
  if (pr) {
    const t = pr.trees || [];
    for (let i = 0; i < t.length; i += 4) { addTree(w, t[i], t[i + 1], t[i + 3] / 10, t[i + 2], 100003 + i); n.trees++; }
    const lp = pr.lamps || [];
    for (let i = 0; i < lp.length; i += 4) { lamp(w, lp[i], lp[i + 1], lp[i + 2] * D2R, lp[i + 3]); n.lamps++; }
    const sg = pr.signals || [];
    for (let i = 0; i < sg.length; i += 3) { signal(w, sg[i], sg[i + 1], sg[i + 2] * D2R); n.signals++; }
    const cr = pr.crossings || [];
    for (let i = 0; i < cr.length; i += 5) n.crossings += crossing(w, cr[i], cr[i + 1], cr[i + 2] * D2R, cr[i + 3], cr[i + 4]);
    const st = pr.stops || [];
    for (let i = 0; i < st.length; i += 4) { busStop(w, st[i], st[i + 1], st[i + 2] * D2R, st[i + 3]); n.stops++; }
    const fu = pr.furniture || [];
    for (let i = 0; i < fu.length; i += 4) { furniture(w, fu[i], fu[i + 1], fu[i + 2], fu[i + 3] * D2R); n.furniture++; }
    for (const f of pr.fences || []) { fence(w, f.p, f.k); n.fences++; }
    const tw = pr.towers || [];
    for (let i = 0; i < tw.length; i += 3) { tower(w, tw[i], tw[i + 1], tw[i + 2] * D2R); n.towers++; }
    const po = pr.poles || [];
    for (let i = 0; i < po.length; i += 2) { pole(w, po[i], po[i + 1]); n.poles++; }
    for (const v of pr.lines || []) { powerLine(w, v); n.lines++; }
    const pl = pr.play || [];
    for (let i = 0; i < pl.length; i += 4) { play(w, pl[i], pl[i + 1], pl[i + 2], pl[i + 3] * D2R); n.play++; }
  }
  n.bays = parkingBays(w);
  w.stats.props = n;
}

function countObjTris(w) {
  let t = 0;
  for (const o of w.objs.values()) t += o.p.length / 9;
  return t;
}
