// Builds the static world (ground layers, roads, buildings, trees) from the
// compact map file, plus the lookup structures used by the car (collision
// grid, road grid, surface raster) and the minimap image.
//
// Map data is in local metres: x = east, y = north. World space is three.js
// with y up, so a map point (x, y) sits at world (x, 0, -y).

import * as THREE from 'three';
import { addBuildings } from './buildings.js';

export const TILE = 500;

// Flat ground layers are drawn without depth writes, strictly in this order
// (inside one tile mesh triangles render in index order and tiles never
// overlap because every triangle is clipped to its tile). No z-fighting.
const L = {
  coastSand: 0, sea: 1, sand: 2, grass: 3, park: 4, wood: 5, pitch: 6, water: 7, land: 8,
  parking: 9, rail: 10, pier: 11, path: 12, kerb: 13, asphalt: 14, marking: 15,
};
const NLAYERS = 16;

const col = (hex) => new THREE.Color(hex); // sRGB hex -> linear working colour
const C = {
  ground: col(0xb3bf86), sea: col(0x2f84b2), water: col(0x2f84b2), sand: col(0xe6d6a4),
  grass: col(0x9cc46a), park: col(0x86b85c), wood: col(0x5f9445), pitch: col(0x77c25a),
  parking: col(0x8d9094), rail: col(0x75685d), railSteel: col(0x3c3c40), pier: col(0x9a7652),
  path: col(0xcfc6b0), kerb: col(0xc3c2ba), asphalt: [col(0x45484e), col(0x4a4d53), col(0x4e5157), col(0x53565b), col(0x585b60), col(0x5c5f63), col(0x66686b), col(0x8b7a62)],
  white: col(0xf0f0ea), yellow: col(0xe8c34a),
};

// Building geometry, palettes and facade textures live in buildings.js.

function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- 2D helpers
function clipPolyRect(pts, x0, y0, x1, y1) {
  // pts: [[x,y],...]; Sutherland-Hodgman against a rectangle
  let out = pts;
  const pass = (inside, cut) => {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); } else if (pi) out.push(cut(prev, cur));
    }
  };
  pass((p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]);
  if (out.length < 3) return out;
  pass((p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]);
  if (out.length < 3) return out;
  pass((p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]);
  if (out.length < 3) return out;
  pass((p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]);
  return out;
}

export function pointInRing(x, y, r) {
  // r: flat [x,y,x,y...]
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function triangulate(poly) {
  // poly: [outerFlat, ...holesFlat] -> {pts:[[x,y]], tris:[[a,b,c]]}
  const toV = (f) => {
    const v = [];
    for (let i = 0; i < f.length; i += 2) v.push(new THREE.Vector2(f[i], f[i + 1]));
    return v;
  };
  const contour = toV(poly[0]);
  const holes = poly.slice(1).map(toV);
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const pts = contour.concat(...holes).map((v) => [v.x, v.y]);
  return { pts, tris };
}

// ---------------------------------------------------------------- world
export class World {
  constructor(data) {
    this.data = data;
    this.bounds = data.bounds;
    this.group = new THREE.Group();
    const [cx0, cy0, cx1, cy1] = data.clip;
    this.tx0 = Math.floor(cx0 / TILE);
    this.ty0 = Math.floor(cy0 / TILE);
    this.tx1 = Math.floor(cx1 / TILE);
    this.ty1 = Math.floor(cy1 / TILE);
    this.flat = new Map();   // tileKey -> layers[] of number arrays
    this.objs = new Map();   // tileKey -> {p:[], n:[], c:[]}
    this.stats = { flatTris: 0, objTris: 0 };

    this.colGrid = new Map(); // collision: segments + circles, cell 16 m
    this.CG = 16;
    this.roadGrid = new Map(); // road segments, cell 24 m
    this.RG = 24;
    this.buildingPolys = [];

    this.buildFlat();
    this.buildBuildings();
    this.buildTrees();
    this.buildPois();
    this.buildRoadGrid();
    this.finishMeshes();
    this.buildRaster();
    this.buildMinimap();
  }

  // ------------------------------------------------------------ flat layers
  tileKey(ix, iy) { return ix * 4096 + iy; }

  flatTri(layer, ax, ay, bx, by, cx, cy, color) {
    // ensure counter-clockwise (seen from above) so the face points up
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) { const tx = bx, ty = by; bx = cx; by = cy; cx = tx; cy = ty; }
    const ix0 = Math.floor(Math.min(ax, bx, cx) / TILE), ix1 = Math.floor(Math.max(ax, bx, cx) / TILE);
    const iy0 = Math.floor(Math.min(ay, by, cy) / TILE), iy1 = Math.floor(Math.max(ay, by, cy) / TILE);
    if (ix0 === ix1 && iy0 === iy1) { this.pushFlat(ix0, iy0, layer, [ax, ay, bx, by, cx, cy], color); return; }
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        // Tiles overlap a little across seams, and higher layers overlap
        // further than lower ones, so a lower layer's clipped edge is always
        // covered and no hairline cracks show along tile seams.
        const e = 0.01 + 0.012 * layer;
        const poly = clipPolyRect([[ax, ay], [bx, by], [cx, cy]], ix * TILE - e, iy * TILE - e, (ix + 1) * TILE + e, (iy + 1) * TILE + e);
        if (poly.length < 3) continue;
        for (let k = 1; k < poly.length - 1; k++) {
          this.pushFlat(ix, iy, layer, [poly[0][0], poly[0][1], poly[k][0], poly[k][1], poly[k + 1][0], poly[k + 1][1]], color);
        }
      }
    }
  }

  pushFlat(ix, iy, layer, xy, color) {
    if (ix < this.tx0 || ix > this.tx1 || iy < this.ty0 || iy > this.ty1) return;
    const k = this.tileKey(ix, iy);
    let t = this.flat.get(k);
    if (!t) { t = Array.from({ length: NLAYERS }, () => []); this.flat.set(k, t); }
    t[layer].push(xy[0], xy[1], xy[2], xy[3], xy[4], xy[5], color.r, color.g, color.b);
  }

  polygon(layer, poly, color) {
    let tr;
    try { tr = triangulate(poly); } catch (e) { return; }
    const { pts, tris } = tr;
    for (const [a, b, c] of tris) this.flatTri(layer, pts[a][0], pts[a][1], pts[b][0], pts[b][1], pts[c][0], pts[c][1], color);
  }

  disc(layer, x, y, r, color, seg = 10) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      this.flatTri(layer, x, y, x + Math.cos(a0) * r, y + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r, color);
    }
  }

  ribbon(layer, p, width, color, caps = true) {
    const n = p.length / 2;
    if (n < 2) return;
    const hw = width / 2;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const x = p[2 * i], y = p[2 * i + 1];
      let nx = 0, ny = 0;
      let d0x = 0, d0y = 0, d1x = 0, d1y = 0;
      if (i > 0) { d0x = x - p[2 * i - 2]; d0y = y - p[2 * i - 1]; const l = Math.hypot(d0x, d0y) || 1; d0x /= l; d0y /= l; }
      if (i < n - 1) { d1x = p[2 * i + 2] - x; d1y = p[2 * i + 3] - y; const l = Math.hypot(d1x, d1y) || 1; d1x /= l; d1y /= l; }
      if (i === 0) { d0x = d1x; d0y = d1y; }
      if (i === n - 1) { d1x = d0x; d1y = d0y; }
      // left normals
      const n0x = -d0y, n0y = d0x, n1x = -d1y, n1y = d1x;
      nx = n0x + n1x; ny = n0y + n1y;
      const l = Math.hypot(nx, ny);
      if (l < 1e-6) { nx = n1x; ny = n1y; } else { nx /= l; ny /= l; }
      let s = 1 / Math.max(0.35, nx * n1x + ny * n1y);
      s = Math.min(s, 2.5);
      L.push(x + nx * hw * s, y + ny * hw * s);
      R.push(x - nx * hw * s, y - ny * hw * s);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = 2 * i, b = 2 * i + 2;
      this.flatTri(layer, L[a], L[a + 1], R[a], R[a + 1], R[b], R[b + 1], color);
      this.flatTri(layer, L[a], L[a + 1], R[b], R[b + 1], L[b], L[b + 1], color);
    }
    if (caps) {
      this.disc(layer, p[0], p[1], hw, color);
      this.disc(layer, p[2 * n - 2], p[2 * n - 1], hw, color);
    }
  }

  // thin line (solid or dashed) offset sideways from a polyline, skipping
  // the arc-length ranges in `skip` ([[s0,s1],...])
  line(layer, p, offset, width, dash, gap, skip, color) {
    const n = p.length / 2;
    let s = 0;
    const period = dash + gap;
    for (let i = 0; i < n - 1; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const nx = -dy, ny = dx;
      // candidate dash intervals in [s, s+len]
      const ivals = [];
      if (!isFinite(period)) ivals.push([s, s + len]);
      else {
        let k = Math.floor(s / period);
        for (; k * period < s + len; k++) {
          const a = Math.max(s, k * period), b = Math.min(s + len, k * period + dash);
          if (b > a) ivals.push([a, b]);
        }
      }
      for (let [a, b] of ivals) {
        let pieces = [[a, b]];
        for (const [k0, k1] of skip) {
          const next = [];
          for (const [u, v] of pieces) {
            if (k1 <= u || k0 >= v) next.push([u, v]);
            else { if (k0 > u) next.push([u, k0]); if (k1 < v) next.push([k1, v]); }
          }
          pieces = next;
        }
        for (const [u, v] of pieces) {
          if (v - u < 0.3) continue;
          const t0 = u - s, t1 = v - s;
          const ox = nx * offset, oy = ny * offset, wx = nx * width / 2, wy = ny * width / 2;
          const x0 = ax + dx * t0 + ox, y0 = ay + dy * t0 + oy, x1 = ax + dx * t1 + ox, y1 = ay + dy * t1 + oy;
          this.flatTri(layer, x0 + wx, y0 + wy, x0 - wx, y0 - wy, x1 - wx, y1 - wy, color);
          this.flatTri(layer, x0 + wx, y0 + wy, x1 - wx, y1 - wy, x1 + wx, y1 + wy, color);
        }
      }
      s += len;
    }
  }

  buildFlat() {
    const d = this.data;
    for (const c of d.coast || []) this.ribbon(L.coastSand, c, 34, C.sand, false);
    for (const p of d.sea) this.polygon(L.sea, p, C.sea);
    const A = d.areas;
    for (const p of A.sand) this.polygon(L.sand, p, C.sand);
    for (const p of A.grass) this.polygon(L.grass, p, C.grass);
    for (const p of A.park) this.polygon(L.park, p, C.park);
    for (const p of A.wood) this.polygon(L.wood, p, C.wood);
    for (const p of A.pitch) this.polygon(L.pitch, p, C.pitch);
    for (const p of A.water) this.polygon(L.water, p, C.water);
    for (const p of A.land) this.polygon(L.land, p, C.ground);
    for (const p of A.parking) this.polygon(L.parking, p, C.parking);
    for (const p of A.pier) this.polygon(L.pier, p, C.pier);
    for (const pl of d.piers) this.ribbon(L.pier, pl.p, pl.w, C.pier);
    for (const r of d.rail) {
      this.ribbon(L.rail, r, 3, C.rail, false);
      this.line(L.rail, r, 0.72, 0.12, Infinity, 0, [], C.railSteel);
      this.line(L.rail, r, -0.72, 0.12, Infinity, 0, [], C.railSteel);
    }
    for (const r of d.roads) {
      if (r.c === 8) { this.ribbon(L.path, r.p, r.w, C.path); continue; }
      const asphalt = r.u ? C.asphalt[7] : C.asphalt[r.c];
      if (r.c <= 5) this.ribbon(L.kerb, r.p, r.w + (r.c <= 3 ? 1.2 : 0.8), C.kerb);
      this.ribbon(L.asphalt, r.p, r.w, asphalt);
      if (r.c <= 3 && !r.u) this.markings(r);
    }
  }

  markings(r) {
    const p = r.p;
    const n = p.length / 2;
    // arc length of each vertex, to trim markings around junctions
    const arc = [0];
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
    const total = arc[n - 1];
    const trimR = 7;
    const skip = (r.j || []).map((i) => [arc[i] - trimR, arc[i] + trimR]);
    skip.push([-1, 2], [total - 2, total + 1]);
    if (!r.o && !r.r) this.line(L.marking, p, 0, 0.16, 3, 6, skip, C.white);
    if (r.c <= 2 && r.w >= 6) {
      const skipEdge = (r.j || []).map((i) => [arc[i] - trimR - 3, arc[i] + trimR + 3]);
      const off = r.w / 2 - 0.45;
      this.line(L.marking, p, off, 0.13, Infinity, 0, skipEdge, C.white);
      this.line(L.marking, p, -off, 0.13, Infinity, 0, skipEdge, C.white);
    }
  }

  // ------------------------------------------------------------ 3D objects
  obj(x, y) {
    const ix = Math.floor(x / TILE), iy = Math.floor(y / TILE);
    const k = this.tileKey(ix, iy);
    let o = this.objs.get(k);
    if (!o) { o = { p: [], n: [], c: [] }; this.objs.set(k, o); }
    return o;
  }

  // world-space triangle with a flat normal; winding fixed to match normal
  tri3(o, a, b, c, nrm, color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    let cs = Array.isArray(color) ? color : [color, color, color];
    if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] < 0) { const t = b; b = c; c = t; cs = [cs[0], cs[2], cs[1]]; }
    o.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    o.n.push(nrm[0], nrm[1], nrm[2], nrm[0], nrm[1], nrm[2], nrm[0], nrm[1], nrm[2]);
    for (const k of cs) o.c.push(k.r, k.g, k.b);
  }

  addColSeg(ax, ay, bx, by) {
    const G = this.CG;
    const gx0 = Math.floor(Math.min(ax, bx) / G), gx1 = Math.floor(Math.max(ax, bx) / G);
    const gy0 = Math.floor(Math.min(ay, by) / G), gy1 = Math.floor(Math.max(ay, by) / G);
    const seg = [ax, ay, bx, by];
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) this.colCell(gx, gy).s.push(seg);
  }
  colCell(gx, gy) {
    const k = gx * 65536 + gy;
    let c = this.colGrid.get(k);
    if (!c) { c = { s: [], c: [], p: [] }; this.colGrid.set(k, c); }
    return c;
  }
  addColCircle(x, y, r) {
    const G = this.CG;
    for (let gx = Math.floor((x - r) / G); gx <= Math.floor((x + r) / G); gx++)
      for (let gy = Math.floor((y - r) / G); gy <= Math.floor((y + r) / G); gy++) this.colCell(gx, gy).c.push([x, y, r]);
  }

  buildBuildings() {
    // visible geometry: own meshes, merged per chunk (src/buildings.js)
    addBuildings(this, this.data.buildings);
    // collision: the footprint walls, exactly as drawn on the map
    this.data.buildings.forEach((b) => {
      if (b.k === 4) return; // roofs / carports: drive under them
      for (const ring of [b.p, ...(b.i || [])]) {
        const n = ring.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[2 * j], by = ring[2 * j + 1];
          if (Math.hypot(bx - ax, by - ay) < 0.05) continue;
          this.addColSeg(ax, ay, bx, by);
        }
      }
      const poly = { p: b.p, bb: bbox(b.p) };
      this.buildingPolys.push(poly);
      const G = this.CG;
      for (let gx = Math.floor(poly.bb[0] / G); gx <= Math.floor(poly.bb[2] / G); gx++)
        for (let gy = Math.floor(poly.bb[1] / G); gy <= Math.floor(poly.bb[3] / G); gy++) this.colCell(gx, gy).p.push(poly);
    });
  }

  buildTrees() {
    const t = this.data.trees;
    const ico = new THREE.IcosahedronGeometry(1, 0); // already non-indexed
    const ip = ico.attributes.position.array;
    const greens = [0x5d7f3c, 0x6c8f4a, 0x4f7036, 0x7a9450, 0x587a46].map(col);
    const trunk = col(0x6b5340);
    for (let k = 0; k < t.length; k += 3) {
      const x = t[k], y = t[k + 1], s = t[k + 2];
      const o = this.obj(x, y);
      const g = greens[Math.floor(hash(k + 11) * greens.length)];
      const sx = 2.4 * s, sy = 2.1 * s, cy = 3.4 * s;
      const rot = hash(k + 5) * 6.28;
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
        // icosahedron faces point away from its centre
        const mx = (v[0][0] + v[1][0] + v[2][0]) / 3 - x, my = (v[0][1] + v[1][1] + v[2][1]) / 3 - cy, mz = (v[0][2] + v[1][2] + v[2][2]) / 3 + y;
        if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const shade = g.clone().multiplyScalar(0.85 + 0.25 * Math.max(0, ny));
        this.tri3(o, v[0], v[1], v[2], [nx, ny, nz], shade);
      }
      // trunk: triangular prism
      const tr = 0.22 * s + 0.08, th = cy - sy * 0.5;
      for (let q = 0; q < 3; q++) {
        const a0 = rot + (q / 3) * Math.PI * 2, a1 = rot + ((q + 1) / 3) * Math.PI * 2;
        const ax = x + Math.cos(a0) * tr, az = -y + Math.sin(a0) * tr, bx = x + Math.cos(a1) * tr, bz = -y + Math.sin(a1) * tr;
        const am = (a0 + a1) / 2;
        const nrm = [Math.cos(am), 0, Math.sin(am)];
        this.tri3(o, [ax, 0, az], [bx, 0, bz], [bx, th, bz], nrm, trunk);
        this.tri3(o, [ax, 0, az], [bx, th, bz], [ax, th, az], nrm, trunk);
      }
      this.addColCircle(x, y, 0.55);
    }
  }

  buildPois() {
    for (const p of this.data.pois || []) {
      if (p.t !== 'lighthouse') continue;
      // tall tower with a black-and-white checker pattern
      const o = this.obj(p.x, p.y);
      const seg = 12, bands = 10, r0 = p.r, r1 = p.r * 0.75, h = p.h - 3;
      const black = col(0x1d1e22), white = col(0xf2f2ee);
      for (let j = 0; j < bands; j++) {
        const y0 = (j / bands) * h, y1 = ((j + 1) / bands) * h;
        const ra = r0 + (r1 - r0) * (j / bands), rb = r0 + (r1 - r0) * ((j + 1) / bands);
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
          const nrm = [Math.cos(am), 0.05, Math.sin(am)];
          const c = (i + j) % 2 ? black : white;
          const A0 = [p.x + Math.cos(a0) * ra, y0, -p.y + Math.sin(a0) * ra], B0 = [p.x + Math.cos(a1) * ra, y0, -p.y + Math.sin(a1) * ra];
          const A1 = [p.x + Math.cos(a0) * rb, y1, -p.y + Math.sin(a0) * rb], B1 = [p.x + Math.cos(a1) * rb, y1, -p.y + Math.sin(a1) * rb];
          this.tri3(o, A0, B0, B1, nrm, c);
          this.tri3(o, A0, B1, A1, nrm, c);
        }
      }
      // lantern + cap
      const lant = col(0x2a3a44), cap = col(0xb33a2e);
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
        const rl = r1 * 0.8;
        const nrm = [Math.cos(am), 0, Math.sin(am)];
        const A0 = [p.x + Math.cos(a0) * rl, h, -p.y + Math.sin(a0) * rl], B0 = [p.x + Math.cos(a1) * rl, h, -p.y + Math.sin(a1) * rl];
        const A1 = [A0[0], h + 1.8, A0[2]], B1 = [B0[0], h + 1.8, B0[2]];
        this.tri3(o, A0, B0, B1, nrm, lant);
        this.tri3(o, A0, B1, A1, nrm, lant);
        const top = [p.x, h + 3.2, -p.y];
        this.tri3(o, [A1[0] + Math.cos(a0) * 0.3, h + 1.8, A1[2] + Math.sin(a0) * 0.3], [B1[0] + Math.cos(a1) * 0.3, h + 1.8, B1[2] + Math.sin(a1) * 0.3], top, [Math.cos(am), 0.7, Math.sin(am)], cap);
      }
      this.addColCircle(p.x, p.y, r0 + 0.2);
    }
  }

  // ------------------------------------------------------------ road lookup
  buildRoadGrid() {
    const G = this.RG;
    this.data.roads.forEach((r, ri) => {
      const p = r.p;
      for (let i = 0; i < p.length - 2; i += 2) {
        const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
        const pad = r.w / 2 + 2;
        const seg = [ax, ay, bx, by, ri];
        for (let gx = Math.floor((Math.min(ax, bx) - pad) / G); gx <= Math.floor((Math.max(ax, bx) + pad) / G); gx++)
          for (let gy = Math.floor((Math.min(ay, by) - pad) / G); gy <= Math.floor((Math.max(ay, by) + pad) / G); gy++) {
            const k = gx * 65536 + gy;
            let c = this.roadGrid.get(k);
            if (!c) { c = []; this.roadGrid.set(k, c); }
            c.push(seg);
          }
      }
    });
  }

  // nearest road segment to (x,y); filter(road) optional. Returns
  // {road, dist, dx, dy, px, py} or null. Searches `rings` cells outward.
  nearestRoad(x, y, maxDist = 30, filter = null) {
    const G = this.RG;
    const gx = Math.floor(x / G), gy = Math.floor(y / G);
    const rings = Math.ceil(maxDist / G);
    let best = null, bestD = maxDist;
    const seen = new Set();
    for (let ring = 0; ring <= rings; ring++) {
      for (let ix = gx - ring; ix <= gx + ring; ix++) for (let iy = gy - ring; iy <= gy + ring; iy++) {
        if (Math.max(Math.abs(ix - gx), Math.abs(iy - gy)) !== ring) continue;
        const cell = this.roadGrid.get(ix * 65536 + iy);
        if (!cell) continue;
        for (const s of cell) {
          if (seen.has(s)) continue;
          seen.add(s);
          const r = this.data.roads[s[4]];
          if (filter && !filter(r)) continue;
          const dx = s[2] - s[0], dy = s[3] - s[1];
          const l2 = dx * dx + dy * dy || 1e-9;
          let t = ((x - s[0]) * dx + (y - s[1]) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = s[0] + dx * t, py = s[1] + dy * t;
          const d = Math.hypot(x - px, y - py) - r.w / 2;
          if (d < bestD) { bestD = d; const l = Math.sqrt(l2); best = { road: r, dist: d, dx: dx / l, dy: dy / l, px, py }; }
        }
      }
      if (best && best.dist < (ring - 1) * G) break;
    }
    return best;
  }

  // ------------------------------------------------------------ surface raster
  buildRaster() {
    const [x0, y0, x1, y1] = this.bounds;
    const N = 2048;
    const mpp = Math.max(x1 - x0, y1 - y0) / N;
    this.raster = { N, mpp, x0, y1 };
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    const d = this.data;
    const tr = (x, y) => [(x - x0) / mpp, (y1 - y) / mpp];
    const fillPolys = (polys, style) => {
      g.fillStyle = style;
      for (const poly of polys) {
        g.beginPath();
        for (const ring of poly) pathRing(g, ring, tr);
        g.fill('evenodd');
      }
    };
    // channel codes: R = water, G = sand, B = paved, G=96 = rough (wood)
    fillPolys(d.areas.wood, 'rgb(0,96,0)');
    g.strokeStyle = 'rgb(0,255,0)';
    g.lineWidth = 34 / mpp;
    for (const c of d.coast || []) { g.beginPath(); pathLine(g, c, tr); g.stroke(); }
    fillPolys(d.sea, 'rgb(255,0,0)');
    fillPolys(d.areas.sand, 'rgb(0,255,0)');
    fillPolys(d.areas.water, 'rgb(255,0,0)');
    fillPolys(d.areas.land, 'rgb(0,0,0)');
    fillPolys(d.areas.parking, 'rgb(0,0,255)');
    fillPolys(d.areas.pier, 'rgb(0,0,255)');
    g.strokeStyle = 'rgb(0,0,255)';
    g.lineCap = 'round';
    for (const pl of d.piers) { g.lineWidth = pl.w / mpp; g.beginPath(); pathLine(g, pl.p, tr); g.stroke(); }
    const img = g.getImageData(0, 0, N, N).data;
    const codes = new Uint8Array(N * N);
    for (let i = 0, j = 0; i < codes.length; i++, j += 4) {
      const r = img[j], gg = img[j + 1], b = img[j + 2];
      codes[i] = r > 127 ? 1 : b > 127 ? 3 : gg > 175 ? 2 : gg > 48 ? 4 : 0;
    }
    this.raster.codes = codes;
  }

  // 'road' | 'paved' | 'grass' | 'sand' | 'rough' | 'water'
  surfaceAt(x, y) {
    const near = this.nearestRoad(x, y, 4);
    if (near && near.dist < 0.4) return near.road.u ? 'gravel' : 'road';
    const R = this.raster;
    const u = Math.floor((x - R.x0) / R.mpp), v = Math.floor((R.y1 - y) / R.mpp);
    if (u < 0 || v < 0 || u >= R.N || v >= R.N) return 'water';
    const c = R.codes[v * R.N + u];
    return c === 1 ? 'water' : c === 2 ? 'sand' : c === 3 ? 'paved' : c === 4 ? 'rough' : 'grass';
  }

  // ------------------------------------------------------------ minimap image
  buildMinimap() {
    const [x0, y0, x1, y1] = this.bounds;
    const N = 2048;
    const mpp = Math.max(x1 - x0, y1 - y0) / N;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    const d = this.data;
    const tr = (x, y) => [(x - x0) / mpp, (y1 - y) / mpp];
    const fill = (polys, style) => {
      g.fillStyle = style;
      for (const poly of polys) { g.beginPath(); for (const ring of poly) pathRing(g, ring, tr); g.fill('evenodd'); }
    };
    g.fillStyle = '#c9cfa9';
    g.fillRect(0, 0, N, N);
    g.strokeStyle = '#eadfb4';
    g.lineWidth = 30 / mpp;
    for (const c of d.coast || []) { g.beginPath(); pathLine(g, c, tr); g.stroke(); }
    fill(d.sea, '#4f9ccc');
    fill(d.areas.sand, '#eadfb4');
    fill([...d.areas.grass, ...d.areas.park, ...d.areas.pitch], '#a9d08a');
    fill(d.areas.wood, '#86b86f');
    fill(d.areas.water, '#4f9ccc');
    fill(d.areas.parking, '#bfc0bf');
    g.fillStyle = '#b3aca2';
    for (const b of d.buildings) { g.beginPath(); pathRing(g, b.p, tr); g.fill(); }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const roadsBy = (filter, style, extra = 0) => {
      g.strokeStyle = style;
      for (const r of d.roads) {
        if (!filter(r)) continue;
        g.lineWidth = Math.max(1.2, (r.w + extra) / mpp * 1.6);
        g.beginPath(); pathLine(g, r.p, tr); g.stroke();
      }
    };
    roadsBy((r) => r.c >= 4 && r.c < 8, '#ffffff');
    roadsBy((r) => r.c <= 3, '#7c6a3a', 3);
    roadsBy((r) => r.c <= 3, '#ffd77a');
    this.minimap = { canvas: cv, mpp, x0, y1, N };
  }

  // ------------------------------------------------------------ meshes
  finishMeshes() {
    const flatMat = new THREE.MeshBasicMaterial({ vertexColors: true, depthWrite: false, side: THREE.DoubleSide });
    const objMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.flatMaterial = flatMat;
    this.objMaterial = objMat;
    for (const [k, layers] of this.flat) {
      let n = 0;
      for (const l of layers) n += l.length / 9;
      const pos = new Float32Array(n * 9), colr = new Float32Array(n * 9);
      let o = 0;
      for (const l of layers) {
        for (let i = 0; i < l.length; i += 9) {
          pos[o] = l[i]; pos[o + 1] = 0; pos[o + 2] = -l[i + 1];
          pos[o + 3] = l[i + 2]; pos[o + 4] = 0; pos[o + 5] = -l[i + 3];
          pos[o + 6] = l[i + 4]; pos[o + 7] = 0; pos[o + 8] = -l[i + 5];
          for (let q = 0; q < 3; q++) { colr[o + q * 3] = l[i + 6]; colr[o + q * 3 + 1] = l[i + 7]; colr[o + q * 3 + 2] = l[i + 8]; }
          o += 9;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, flatMat);
      m.renderOrder = -5;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.stats.flatTris += n;
    }
    this.flat = null;
    for (const [k, o] of this.objs) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.p), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(o.n), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(o.c), 3));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, objMat);
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.stats.objTris += o.p.length / 9;
    }
    this.objs = null;
    // ground under everything (land colour); the sea is drawn on top of it
    const g = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshBasicMaterial({ color: C.ground, depthWrite: false }));
    g.rotation.x = -Math.PI / 2;
    g.renderOrder = -10;
    g.position.set((this.bounds[0] + this.bounds[2]) / 2, 0, -(this.bounds[1] + this.bounds[3]) / 2);
    this.ground = g;
    this.group.add(g);
  }
}

function bbox(f) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < f.length; i += 2) { a = Math.min(a, f[i]); c = Math.max(c, f[i]); b = Math.min(b, f[i + 1]); d = Math.max(d, f[i + 1]); }
  return [a, b, c, d];
}
function pathRing(g, f, tr) {
  for (let i = 0; i < f.length; i += 2) {
    const [u, v] = tr(f[i], f[i + 1]);
    if (i === 0) g.moveTo(u, v); else g.lineTo(u, v);
  }
  g.closePath();
}
function pathLine(g, f, tr) {
  for (let i = 0; i < f.length; i += 2) {
    const [u, v] = tr(f[i], f[i + 1]);
    if (i === 0) g.moveTo(u, v); else g.lineTo(u, v);
  }
}
