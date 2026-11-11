// Builds the static world (ground layers, roads, buildings, trees) from the
// compact map file, plus the lookup structures used by the car (collision
// grid, road grid, surface raster) and the minimap image.
//
// Map data is in local metres: x = east, y = north. World space is three.js
// with y up, so a map point (x, y) sits at world (x, 0, -y).

import * as THREE from 'three';
import { addBuildings } from './buildings.js';
import { makeGroundMaterial, makeObjectMaterial } from './materials.js';

export const TILE = 500;

// Flat ground layers are drawn without depth writes, strictly in this order
// (inside one tile mesh triangles render in index order and tiles never
// overlap because every triangle is clipped to its tile). No z-fighting.
const L = {
  coastSand: 0, sea: 1, shallows: 2, coastEdge: 3, sand: 4, grass: 5, park: 6, wood: 7, pitch: 8, water: 9, land: 10,
  waterEdge: 11, shadow: 12, parking: 13, court: 14, pitchMark: 15, rail: 16, pier: 17, path: 18, kerb: 19, asphalt: 20,
  island: 21, marking: 22, bridgeDeck: 23, bridgeAsphalt: 24, bridgeMarking: 25,
};
const NLAYERS = 26;

const col = (hex) => new THREE.Color(hex); // sRGB hex -> linear working colour
const C = {
  ground: col(0xb3bf86), sea: col(0x2f84b2), water: col(0x2f84b2), sand: col(0xe6d6a4),
  shallows: col(0x3f9cbd), foam: col(0xd9ebe8), rock: col(0x7b766d), rockLight: col(0xb0aa9e),
  grass: col(0x9cc46a), park: col(0x86b85c), wood: col(0x5f9445), pitch: col(0x77c25a),
  parking: col(0x8d9094), rail: col(0x75685d), railSteel: col(0x3c3c40), pier: col(0x9a7652),
  path: col(0xcfc6b0), kerb: col(0xc3c2ba), asphalt: [col(0x45484e), col(0x4a4d53), col(0x4e5157), col(0x53565b), col(0x585b60), col(0x5c5f63), col(0x66686b), col(0x8b7a62)],
  white: col(0xf0f0ea), yellow: col(0xe8c34a), island: col(0x8fbf62), deck: col(0xb4b1a8),
  bridgeShadow: col(0x1f5f85), parapet: col(0xe0ddd4), railing: col(0x9b8468), steel: col(0xb9bec2),
  cricket: col(0xcdb98a), court: col(0x4d7f8f), post: col(0xf4f4f0), apron: col(0xa98270),
};
// map an asphalt colour index from a road (unpaved roads are brown gravel)
const asphaltOf = (r) => (r.u ? C.asphalt[7] : C.asphalt[Math.min(r.c, 6)]);

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

  // caps: true/false, or [startCap, endCap]
  ribbon(layer, p, width, color, caps = true) {
    const n = p.length / 2;
    if (n < 2) return;
    const hw = width / 2;
    const L = offsetLine(p, hw), R = offsetLine(p, -hw);
    for (let i = 0; i < n - 1; i++) {
      const a = 2 * i, b = 2 * i + 2;
      this.flatTri(layer, L[a], L[a + 1], R[a], R[a + 1], R[b], R[b + 1], color);
      this.flatTri(layer, L[a], L[a + 1], R[b], R[b + 1], L[b], L[b + 1], color);
    }
    const c0 = Array.isArray(caps) ? caps[0] : caps, c1 = Array.isArray(caps) ? caps[1] : caps;
    if (c0) this.disc(layer, p[0], p[1], hw, color, hw > 3 ? 14 : 10);
    if (c1) this.disc(layer, p[2 * n - 2], p[2 * n - 1], hw, color, hw > 3 ? 14 : 10);
  }

  // filled ring between radii r0(i) and r1(i) around (x, y); rad(i) gives the
  // centreline radius at angle 2*pi*i/seg
  annulus(layer, x, y, seg, rad, d0, d1, color) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const ra = rad(i), rb = rad(i + 1);
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const ia = Math.max(0, ra + d0), oa = ra + d1, ib = Math.max(0, rb + d0), ob = rb + d1;
      this.flatTri(layer, x + c0 * ia, y + s0 * ia, x + c0 * oa, y + s0 * oa, x + c1 * ob, y + s1 * ob, color);
      if (ia > 0.01 || ib > 0.01) this.flatTri(layer, x + c0 * ia, y + s0 * ia, x + c1 * ob, y + s1 * ob, x + c1 * ib, y + s1 * ib, color);
    }
  }

  // convex polygon from a point list [[x,y],...] (fan)
  convex(layer, pts, color) {
    for (let i = 1; i < pts.length - 1; i++) this.flatTri(layer, pts[0][0], pts[0][1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color);
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
    if (!this.raster) this.buildRaster(); // bridges ask the raster what is under them
    this.buildCoast();
    for (const p of d.sea) this.polygon(L.sea, p, C.sea);
    const A = d.areas;
    for (const p of A.sand) this.polygon(L.sand, p, C.sand);
    for (const p of A.grass) this.polygon(L.grass, p, C.grass);
    for (const p of A.park) this.polygon(L.park, p, C.park);
    for (const p of A.wood) this.polygon(L.wood, p, C.wood);
    for (const p of A.pitch) this.polygon(L.pitch, p, C.pitch);
    for (const p of A.water) this.polygon(L.water, p, C.water);
    for (const rv of d.rivers || []) this.ribbon(L.water, rv.p, rv.w, C.water);
    for (const p of A.land) this.polygon(L.land, p, C.ground);
    // harbour / marina basins: rock-and-concrete quay edge inside the water
    for (const q of d.quays || []) {
      const ring = q.concat(q[0], q[1]);
      this.ribbon(L.waterEdge, offsetLine(ring, 1.3), 2.6, C.rock, false);
      this.ribbon(L.waterEdge, offsetLine(ring, -0.4), 0.8, C.rockLight, false);
    }
    for (const p of A.parking) this.polygon(L.parking, p, C.parking);
    for (const p of A.pier) this.polygon(L.pier, p, C.pier);
    for (const pl of d.piers) {
      this.ribbon(L.pier, pl.p, pl.w, C.pier, false);
      // jetty handrails (visual only)
      for (const side of [-1, 1]) this.railing(offsetLine(pl.p, side * (pl.w / 2 - 0.1)), 1.0, C.railing, 6);
    }
    for (const r of d.rail) {
      this.ribbon(L.rail, r, 3, C.rail, false);
      this.line(L.rail, offsetLine(r, 0.72), 0, 0.12, Infinity, 0, [], C.railSteel);
      this.line(L.rail, offsetLine(r, -0.72), 0, 0.12, Infinity, 0, [], C.railSteel);
    }
    // railway bridges: deck, track and handrails above whatever they cross
    for (const r of d.railBridges || []) {
      this.ribbon(L.bridgeDeck, r, 4.6, C.deck, false);
      this.ribbon(L.bridgeAsphalt, r, 3, C.rail, false);
      this.line(L.bridgeMarking, offsetLine(r, 0.72), 0, 0.12, Infinity, 0, [], C.railSteel);
      this.line(L.bridgeMarking, offsetLine(r, -0.72), 0, 0.12, Infinity, 0, [], C.railSteel);
      const t = trimLine(r, 0.3);
      if (t) for (const side of [-1, 1]) this.railing(offsetLine(t, side * 2.15), 1.0, C.steel, 4);
    }
    this.buildSports();
    this.buildRoads();
  }

  // ------------------------------------------------------------ coast
  // Beach runs get a sand strip (under the sea, so only the land half shows)
  // plus shallows and a foam line; sheltered shores and breakwaters get a
  // rock edge over the water instead.
  buildCoast() {
    for (const c of this.data.coast || []) {
      const p = c.p;
      if (c.k === 0) {
        this.ribbon(L.coastSand, p, 40, C.sand, false);
        // sea is on the right of the coastline direction
        this.ribbon(L.shallows, offsetLine(p, -5), 10, C.shallows, false);
        this.ribbon(L.coastEdge, offsetLine(p, -0.6), 1.2, C.foam, false);
      } else if (c.k === 1) {
        this.ribbon(L.coastEdge, offsetLine(p, -0.6), 3.4, C.rock, false);
        this.ribbon(L.coastEdge, offsetLine(p, 0.9), 1.2, C.rockLight, false);
      } else {
        // breakwater / harbour wall: wide rock armour on both faces
        this.ribbon(L.coastEdge, offsetLine(p, -1.5), 5, C.rock, false);
        this.ribbon(L.coastEdge, offsetLine(p, 3), 4, C.rockLight, false);
      }
    }
  }

  // ------------------------------------------------------------ sports grounds
  buildSports() {
    for (const s of this.data.sports || []) {
      const ux = Math.cos(s.a), uy = Math.sin(s.a), vx = -uy, vy = ux;
      const P = (u, v) => [s.x + ux * u + vx * v, s.y + uy * u + vy * v];
      const hl = s.L / 2, hw = s.W / 2;
      const W = C.white, lw = 0.2;
      const poly = (pts, closed = true) => {
        const f = [];
        for (const q of pts) f.push(q[0], q[1]);
        if (closed) f.push(pts[0][0], pts[0][1]);
        this.line(L.pitchMark, f, 0, lw, Infinity, 0, [], W);
      };
      const rect = (u0, v0, u1, v1) => poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]);
      const circle = (cu, cv, r, a0 = 0, a1 = Math.PI * 2, keep = null) => {
        const n = Math.max(12, Math.ceil(r * 1.2));
        let run = [];
        const flush = () => { if (run.length > 1) poly(run, false); run = []; };
        for (let i = 0; i <= n; i++) {
          const a = a0 + (a1 - a0) * (i / n);
          const u = cu + Math.cos(a) * r, v = cv + Math.sin(a) * r;
          if (keep && !keep(u, v)) { flush(); continue; }
          run.push(P(u, v));
        }
        flush();
      };
      if (s.s === 'afl' || (s.s === 'cricket' && s.L > 90)) {
        // oval: boundary line, then the code-specific markings
        const ra = hl - 3, rb = hw - 3;
        const ell = [];
        for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; ell.push(P(Math.cos(a) * ra, Math.sin(a) * rb)); }
        poly(ell);
        if (s.s === 'afl' && ra > 50) {
          rect(-25, -25, 25, 25);
          circle(0, 0, 5);
          circle(0, 0, 1.5);
          const inside = (u, v) => (u * u) / (ra * ra) + (v * v) / (rb * rb) < 0.995;
          for (const e of [-1, 1]) {
            const g = e * ra;
            circle(g, 0, 50, e > 0 ? Math.PI / 2 : -Math.PI / 2, e > 0 ? Math.PI * 1.5 : Math.PI / 2, inside);
            rect(g, -3.2, g - e * 9, 3.2);
            // goal and behind posts
            for (const [v, h] of [[-3.2, 6.5], [3.2, 6.5], [-9.6, 3.5], [9.6, 3.5]]) {
              const q = P(g, v);
              this.post3(q[0], q[1], 0.12, h, C.post);
            }
          }
        }
        if (s.s === 'cricket' || s.L > 120) {
          // centre wicket strip
          const strip = [P(-10.1, -1.6), P(10.1, -1.6), P(10.1, 1.6), P(-10.1, 1.6)];
          this.convex(L.court, strip, C.cricket);
        }
      } else if (s.s === 'cricket') {
        // a small cricket pitch polygon is the wicket strip itself
        this.convex(L.court, [P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw)], C.cricket);
      } else if (s.s === 'tennis' || s.s === 'basketball' || s.s === 'netball') {
        this.convex(L.court, [P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw)], C.court);
        const m = Math.min(1.5, hw * 0.12);
        rect(-hl + m, -hw + m, hl - m, hw - m);
        poly([P(0, -hw + m), P(0, hw - m)], false);
        if (s.s !== 'tennis' && hl > 8) circle(0, 0, Math.min(1.8, hw * 0.25));
      } else if (hl > 20) {
        // soccer / rugby / hockey rectangle
        const m = 2;
        const a = hl - m, b = hw - m;
        rect(-a, -b, a, b);
        poly([P(0, -b), P(0, b)], false);
        circle(0, 0, Math.min(9.15, b * 0.3));
        if (s.s === 'soccer' && b > 22) {
          for (const e of [-1, 1]) rect(e * a, -20.15, e * (a - 16.5), 20.15);
        }
        if (s.s === 'rugby') for (const e of [-1, 1]) poly([P(e * (a - 22), -b), P(e * (a - 22), b)], false);
      }
    }
  }

  // ------------------------------------------------------------ roads
  // Junction-aware road drawing:
  //  - every node where 3+ road arms meet gets a convex "junction plate"
  //    (asphalt, with a matching kerb plate below), so strips never show
  //    caps, kerbs or bulges inside the junction;
  //  - markings stop at the plate; minor approaches get give-way lines;
  //  - roundabouts are drawn as smooth annuli with a round kerbed island;
  //  - bridges are drawn on top as a deck with parapets.
  buildRoads() {
    const d = this.data;
    const roads = d.roads;
    const key = (x, y) => x + ',' + y;
    // arc lengths
    const arcs = roads.map((r) => {
      const p = r.p, n = p.length / 2, a = [0];
      for (let i = 1; i < n; i++) a.push(a[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
      return a;
    });
    // junction nodes -> arms (an arm leaves the node along one road, in one
    // direction; len is the distance to the next junction or the road end)
    const nodes = new Map();
    roads.forEach((r, ri) => {
      if (r.c >= 8 || !r.j) return;
      const arc = arcs[ri], n = r.p.length / 2;
      const jset = r.j;
      for (let k = 0; k < jset.length; k++) {
        const i = jset[k];
        const x = r.p[2 * i], y = r.p[2 * i + 1];
        const kk = key(x, y);
        let nd = nodes.get(kk);
        if (!nd) { nd = { x, y, arms: [] }; nodes.set(kk, nd); }
        const prevJ = k > 0 ? jset[k - 1] : 0, nextJ = k < jset.length - 1 ? jset[k + 1] : n - 1;
        if (i > 0) nd.arms.push({ r, ri, i, dir: -1, len: arc[i] - arc[prevJ] || arc[i], other: k > 0 ? prevJ : -1 });
        if (i < n - 1) nd.arms.push({ r, ri, i, dir: 1, len: arc[nextJ] - arc[i] || arc[n - 1] - arc[i], other: k < jset.length - 1 ? nextJ : -1 });
      }
    });
    const skips = roads.map(() => []);
    const edgeSkips = roads.map(() => []);
    const noCap = roads.map(() => [false, false]);
    const giveWays = [];
    const plates = [];
    for (const nd of nodes.values()) {
      const arms = nd.arms;
      if (arms.length < 3) continue;
      const ring = arms.find((a) => a.r.r === 2);
      let minC = 9, maxHw = 0;
      for (const a of arms) { minC = Math.min(minC, a.r.c); maxHw = Math.max(maxHw, a.r.w / 2); }
      for (const a of arms) {
        const n = a.r.p.length / 2;
        if (a.i === 0) noCap[a.ri][0] = true;
        if (a.i === n - 1) noCap[a.ri][1] = true;
      }
      if (ring) {
        const rhw = ring.r.w / 2;
        for (const a of arms) {
          if (a.r.r === 2) continue;
          const da = Math.min(rhw + 0.9, a.len * 0.6);
          a.da = da;
          const at = arcs[a.ri][a.i];
          const iv = a.dir > 0 ? [at - 0.5, at + da + 1.5] : [at - da - 1.5, at + 0.5];
          skips[a.ri].push(iv);
          edgeSkips[a.ri].push([iv[0] - 1, iv[1] + 1]);
          if (a.r.c < 6) giveWays.push(a);
        }
        continue;
      }
      const dPlate = maxHw + 2.2;
      const pts = [[nd.x, nd.y]], kpts = [];
      let plateRoad = arms[0].r;
      for (const a of arms) {
        if (a.r.c < plateRoad.c || (a.r.c === plateRoad.c && a.r.w > plateRoad.w)) plateRoad = a.r;
        const da = Math.max(0.5, Math.min(dPlate, a.len * 0.5));
        a.da = da;
        const hw = a.r.w / 2;
        const q = pointAlong(a.r.p, arcs[a.ri], a.i, a.dir, da);
        const nx = -q.ty, ny = q.tx;
        pts.push([q.x + nx * hw, q.y + ny * hw], [q.x - nx * hw, q.y - ny * hw]);
        const kw = hw + (a.r.c <= 3 ? 0.6 : a.r.c <= 5 ? 0.4 : 0);
        kpts.push([q.x + nx * kw, q.y + ny * kw], [q.x - nx * kw, q.y - ny * kw]);
        // the start of the strip at the node
        const q0 = pointAlong(a.r.p, arcs[a.ri], a.i, a.dir, 0);
        pts.push([nd.x - q0.ty * hw, nd.y + q0.tx * hw], [nd.x + q0.ty * hw, nd.y - q0.tx * hw]);
        const at = arcs[a.ri][a.i];
        const iv = a.dir > 0 ? [at - 0.5, at + da + 1.2] : [at - da - 1.2, at + 0.5];
        skips[a.ri].push(iv);
        edgeSkips[a.ri].push([iv[0] - 1.5, iv[1] + 1.5]);
        if (a.r.c > minC && a.r.c < 6) giveWays.push(a);
      }
      nd.plate = { pts, kpts, road: plateRoad, kerb: arms.some((a) => a.r.c <= 5), bridge: arms.every((a) => a.r.b) };
      plates.push(nd);
    }
    // Junctions joined by a short arm (dual carriageway crossings, staggered
    // T-junctions) share one plate, so no slivers of verge are left between
    // them. Clusters wider than 34 m fall back to separate plates.
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (const nd of plates) parent.set(key(nd.x, nd.y), key(nd.x, nd.y));
    for (const nd of plates) {
      for (const a of nd.arms) {
        if (a.other < 0 || a.len > 24) continue;
        const ok = key(a.r.p[2 * a.other], a.r.p[2 * a.other + 1]);
        if (!parent.has(ok)) continue;
        const ra = find(key(nd.x, nd.y)), rb = find(ok);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
    const groups = new Map();
    for (const nd of plates) {
      const g = find(key(nd.x, nd.y));
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(nd);
    }
    const plateList = [];
    const addPlate = (list) => {
      let pts = [], kpts = [], road = list[0].plate.road;
      for (const nd of list) {
        pts = pts.concat(nd.plate.pts); kpts = kpts.concat(nd.plate.kpts);
        const r = nd.plate.road;
        if (r.c < road.c || (r.c === road.c && r.w > road.w)) road = r;
      }
      plateList.push({ pts: convexHull(pts), kpts: list.some((nd) => nd.plate.kerb) ? convexHull(pts.concat(kpts)) : null, color: asphaltOf(road), bridge: list.every((nd) => nd.plate.bridge) });
    };
    for (const list of groups.values()) {
      if (list.length > 1) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const nd of list) for (const q of nd.plate.pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
        if (Math.hypot(x1 - x0, y1 - y0) <= 34) { addPlate(list); continue; }
      }
      for (const nd of list) addPlate([nd]);
    }

    // strips
    roads.forEach((r, ri) => {
      if (r.r === 2 || r.b) return; // roundabouts and bridges are drawn below
      const caps = [!noCap[ri][0], !noCap[ri][1]];
      if (r.c === 8) { this.ribbon(L.path, r.p, r.w, C.path, caps); return; }
      if (r.c <= 5) this.ribbon(L.kerb, r.p, r.w + (r.c <= 3 ? 1.2 : 0.8), C.kerb, caps);
      this.ribbon(L.asphalt, r.p, r.w, asphaltOf(r), caps);
    });
    // roundabouts
    for (const rb of d.roundabouts || []) {
      const N = rb.rr.length, SEG = Math.max(36, Math.min(96, Math.round(rb.rr.reduce((a, b) => a + b, 0) / N * 2)));
      const rad = (i) => {
        // periodic linear interpolation of the radius profile
        const t = ((i % SEG) / SEG) * N, k = Math.floor(t), f = t - k;
        return rb.rr[k % N] * (1 - f) + rb.rr[(k + 1) % N] * f;
      };
      const hw = rb.w / 2;
      const asph = rb.c <= 6 ? C.asphalt[rb.c] : C.asphalt[6];
      if (rb.c <= 5) this.annulus(L.kerb, rb.x, rb.y, SEG, rad, -hw - 0.1, hw + 0.7, C.kerb);
      this.annulus(L.asphalt, rb.x, rb.y, SEG, rad, -hw, hw, asph);
      // island: kerb rim, a mountable apron and the planted centre
      this.annulus(L.island, rb.x, rb.y, SEG, rad, -hw - 0.5, -hw, C.kerb);
      const apron = Math.min(1.2, Math.max(0, (rad(0) - hw - 0.5) * 0.2));
      if (apron > 0.3) this.annulus(L.island, rb.x, rb.y, SEG, rad, -hw - 0.5 - apron, -hw - 0.5, C.apron);
      this.annulus(L.island, rb.x, rb.y, SEG, rad, -1e4, -hw - 0.5 - (apron > 0.3 ? apron : 0), C.island);
      if (rb.l >= 2) {
        const f = [];
        for (let i = 0; i <= SEG; i++) { const a = (i / SEG) * Math.PI * 2; f.push(rb.x + Math.cos(a) * rad(i), rb.y + Math.sin(a) * rad(i)); }
        this.line(L.marking, f, 0, 0.13, 3, 4, [], C.white);
      }
    }
    // junction plates
    for (const pl of plateList) {
      if (pl.kpts) this.convex(L.kerb, pl.kpts, C.kerb);
      this.convex(pl.bridge ? L.bridgeAsphalt : L.asphalt, pl.pts, pl.color);
    }
    // markings
    roads.forEach((r, ri) => {
      if (r.c > 3 || r.u || r.r === 2) return;
      this.markings(r, arcs[ri], skips[ri], edgeSkips[ri], r.b ? L.bridgeMarking : L.marking);
    });
    for (const a of giveWays) this.giveWay(a, arcs[a.ri]);
    // bridges
    roads.forEach((r, ri) => { if (r.b && r.r !== 2) this.bridge(r, [!noCap[ri][0], !noCap[ri][1]]); });
  }

  // Lane lines: dashed centre line on two-way roads, lane dividers on
  // multi-lane roads (from lanes=* or the width of one-way carriageways),
  // solid edge lines on arterials.
  markings(r, arc, skip, skipEdge, layer) {
    const p = r.p;
    const total = arc[arc.length - 1];
    const ends = [[-1, 1.5], [total - 1.5, total + 1]];
    skip = skip.concat(ends);
    skipEdge = skipEdge.concat(ends);
    const hw = r.w / 2;
    let lanes = r.l || 0;
    if (r.o) {
      if (!lanes) lanes = r.w >= 6.4 ? Math.round(r.w / 3.3) : 1;
      for (let k = 1; k < lanes; k++) this.line(layer, offsetLine(p, -hw + (r.w * k) / lanes), 0, 0.14, 3, 6, skip, C.white);
    } else if (r.r !== 1) {
      if (lanes >= 4) {
        this.line(layer, offsetLine(p, 0.12), 0, 0.12, Infinity, 0, skip, C.white);
        this.line(layer, offsetLine(p, -0.12), 0, 0.12, Infinity, 0, skip, C.white);
        const per = Math.floor(lanes / 2);
        for (let k = 1; k < per; k++) for (const sd of [-1, 1]) this.line(layer, offsetLine(p, sd * (hw * k) / per), 0, 0.14, 3, 6, skip, C.white);
      } else this.line(layer, p, 0, 0.16, 3, 6, skip, C.white);
    }
    if ((r.c <= 2 && r.w >= 6) || (r.o && r.c <= 3 && r.w >= 5)) {
      const off = hw - 0.45;
      this.line(layer, offsetLine(p, off), 0, 0.13, Infinity, 0, skipEdge, C.white);
      this.line(layer, offsetLine(p, -off), 0, 0.13, Infinity, 0, skipEdge, C.white);
    }
  }

  // dashed give-way line across the approach lane(s) of a minor arm
  giveWay(a, arc) {
    const r = a.r;
    if (r.o && a.dir > 0) return; // one-way leaving the junction
    const q = pointAlong(r.p, arc, a.i, a.dir, a.da + 0.4);
    if (q.s < a.da + 0.3) return; // arm too short
    const hw = r.w / 2;
    // approaching traffic travels along -t; its left is (t.y, -t.x)
    const lx = q.ty, ly = -q.tx;
    const o0 = r.o ? -hw + 0.3 : 0.15, o1 = hw - 0.3;
    if (o1 - o0 < 1) return;
    this.line(r.b ? L.bridgeMarking : L.marking, [q.x + lx * o0, q.y + ly * o0, q.x + lx * o1, q.y + ly * o1], 0, 0.35, 0.6, 0.45, [], C.white);
  }

  // bridge deck with parapets; drivable bridges get parapet collision
  bridge(r, caps) {
    const hw = r.w / 2;
    const foot = r.c === 8;
    const edge = foot ? 0.25 : 0.6;
    // shadow on the water beside the deck (the sun is in the west / south-west)
    if (!foot) {
      const sx = 0.79 * 4, sy = 0.61 * 4;
      const p = r.p, n = p.length / 2;
      let run = [];
      const flush = () => { if (run.length >= 4) this.ribbon(L.shadow, run, r.w + 2 * edge, C.bridgeShadow, false); run = []; };
      for (let i = 0; i < n - 1; i++) {
        const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
        const len = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(len / 2));
        for (let k = 0; k <= steps; k++) {
          if (k === 0 && i > 0) continue;
          const x = ax + ((bx - ax) * k) / steps + sx, y = ay + ((by - ay) * k) / steps + sy;
          if (this.rasterCode(x, y) === 1) run.push(x, y); else flush();
        }
      }
      flush();
    }
    this.ribbon(L.bridgeDeck, r.p, r.w + 2 * edge, foot ? C.pier : C.deck, false);
    this.ribbon(L.bridgeAsphalt, r.p, r.w, foot ? C.path : asphaltOf(r), caps);
    // parapets, kept a little short of the ends so approaches stay clear
    const p = trimLine(r.p, 0.4);
    if (!p) return;
    for (const side of [-1, 1]) {
      const line = offsetLine(p, side * (hw + edge * 0.55));
      if (foot) this.railing(line, 1.0, C.railing, 4);
      else {
        // concrete upstand with a steel rail on posts above it
        this.wall3(line, 0.32, 0.45, C.parapet);
        this.railing(line, 1.0, C.steel, 2.4, 0.45);
        const cl = offsetLine(p, side * (hw + 0.3));
        for (let i = 0; i < cl.length - 2; i += 2) this.addColSeg(cl[i], cl[i + 1], cl[i + 2], cl[i + 3]);
      }
    }
  }

  // posts every `spacing` m plus a top rail along a polyline, from height h0
  railing(p, h, color, spacing, h0 = 0) {
    const n = p.length / 2;
    let acc = spacing;
    for (let i = 0; i < n - 1; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      let s = spacing - acc;
      for (; s <= len; s += spacing) this.post3(ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len, 0.05, h, color, h0);
      acc = len - (s - spacing);
    }
    this.post3(p[2 * n - 2], p[2 * n - 1], 0.05, h, color, h0);
    this.wall3(p, 0.09, h, color, h - 0.1);
  }

  // wall along a polyline (3D object mesh), thickness t, from height h0 to h
  wall3(p, t, h, color, h0 = 0) {
    const n = p.length / 2;
    const top = color.clone().multiplyScalar(1.08), low = h0 > 0 ? color : color.clone().multiplyScalar(0.8);
    for (let i = 0; i < n - 1; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const nx = -(by - ay) / len * t / 2, ny = (bx - ax) / len * t / 2;
      const o = this.obj((ax + bx) / 2, (ay + by) / 2);
      const A = (sx, hh) => [ax + nx * sx, hh, -(ay + ny * sx)], B = (sx, hh) => [bx + nx * sx, hh, -(by + ny * sx)];
      const nrmL = [nx / (t / 2), 0, -ny / (t / 2)], nrmR = [-nrmL[0], 0, -nrmL[2]];
      this.tri3(o, A(1, h0), B(1, h0), B(1, h), nrmL, [low, low, color]);
      this.tri3(o, A(1, h0), B(1, h), A(1, h), nrmL, [low, color, color]);
      this.tri3(o, A(-1, h0), B(-1, h0), B(-1, h), nrmR, [low, low, color]);
      this.tri3(o, A(-1, h0), B(-1, h), A(-1, h), nrmR, [low, color, color]);
      this.tri3(o, A(1, h), B(1, h), B(-1, h), [0, 1, 0], top);
      this.tri3(o, A(1, h), B(-1, h), A(-1, h), [0, 1, 0], top);
    }
  }

  // thin square post (3D)
  post3(x, y, r, h, color, h0 = 0) {
    const o = this.obj(x, y);
    const c = [[r, r], [-r, r], [-r, -r], [r, -r]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, l = Math.hypot(mx, my);
      const nrm = [mx / l, 0, -my / l];
      const A0 = [x + a[0], h0, -(y + a[1])], B0 = [x + b[0], h0, -(y + b[1])], A1 = [x + a[0], h, -(y + a[1])], B1 = [x + b[0], h, -(y + b[1])];
      this.tri3(o, A0, B0, B1, nrm, color);
      this.tri3(o, A0, B1, A1, nrm, color);
    }
  }

  rasterCode(x, y) {
    const R = this.raster;
    const u = Math.floor((x - R.x0) / R.mpp), v = Math.floor((R.y1 - y) / R.mpp);
    if (u < 0 || v < 0 || u >= R.N || v >= R.N) return 1;
    return R.codes[v * R.N + u];
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
    if (this.raster) return; // already built (buildFlat needs it first)
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
    g.lineWidth = 40 / mpp;
    for (const c of d.coast || []) if (c.k === 0) { g.beginPath(); pathLine(g, c.p, tr); g.stroke(); }
    fillPolys(d.sea, 'rgb(255,0,0)');
    fillPolys(d.areas.sand, 'rgb(0,255,0)');
    fillPolys(d.areas.water, 'rgb(255,0,0)');
    g.strokeStyle = 'rgb(255,0,0)';
    g.lineCap = 'round';
    for (const rv of d.rivers || []) { g.lineWidth = rv.w / mpp; g.beginPath(); pathLine(g, rv.p, tr); g.stroke(); }
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
    g.lineWidth = 34 / mpp;
    for (const c of d.coast || []) if (c.k === 0) { g.beginPath(); pathLine(g, c.p, tr); g.stroke(); }
    fill(d.sea, '#4f9ccc');
    fill(d.areas.sand, '#eadfb4');
    fill([...d.areas.grass, ...d.areas.park, ...d.areas.pitch], '#a9d08a');
    fill(d.areas.wood, '#86b86f');
    fill(d.areas.water, '#4f9ccc');
    g.strokeStyle = '#4f9ccc';
    g.lineCap = 'round';
    for (const rv of d.rivers || []) { g.lineWidth = rv.w / mpp; g.beginPath(); pathLine(g, rv.p, tr); g.stroke(); }
    fill(d.areas.pier, '#b39a80');
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
    const flatMat = makeGroundMaterial(); // lit, shadow-receiving, depthWrite:false (src/materials.js)
    const uTime = flatMat.userData.uTime;
    const tickWater = () => { uTime.value = (performance.now() / 1000) % 2000; };
    const objMat = makeObjectMaterial();
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
      m.onBeforeRender = tickWater;
      m.receiveShadow = true;
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
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      this.stats.objTris += o.p.length / 9;
    }
    this.objs = null;
    // ground under everything (land colour); the sea is drawn on top of it
    const g = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), makeGroundMaterial({ color: C.ground }));
    g.rotation.x = -Math.PI / 2;
    g.renderOrder = -10;
    g.receiveShadow = true;
    g.position.set((this.bounds[0] + this.bounds[2]) / 2, 0, -(this.bounds[1] + this.bounds[3]) / 2);
    this.ground = g;
    this.group.add(g);
  }
}

// polyline (flat) shifted sideways by `off` (positive = left), with mitred
// joins (miter limited so sharp bends do not spike)
function offsetLine(p, off) {
  const n = p.length / 2;
  const out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    let d0x = 0, d0y = 0, d1x = 0, d1y = 0;
    if (i > 0) { d0x = x - p[2 * i - 2]; d0y = y - p[2 * i - 1]; const l = Math.hypot(d0x, d0y) || 1; d0x /= l; d0y /= l; }
    if (i < n - 1) { d1x = p[2 * i + 2] - x; d1y = p[2 * i + 3] - y; const l = Math.hypot(d1x, d1y) || 1; d1x /= l; d1y /= l; }
    if (i === 0) { d0x = d1x; d0y = d1y; }
    if (i === n - 1) { d1x = d0x; d1y = d0y; }
    const n0x = -d0y, n0y = d0x, n1x = -d1y, n1y = d1x;
    let nx = n0x + n1x, ny = n0y + n1y;
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) { nx = n1x; ny = n1y; } else { nx /= l; ny /= l; }
    const s = Math.min(2.5, 1 / Math.max(0.35, nx * n1x + ny * n1y));
    out[2 * i] = x + nx * off * s;
    out[2 * i + 1] = y + ny * off * s;
  }
  return out;
}

// point at arc distance `dist` from vertex i of polyline p, walking in
// direction dir (+1 forward / -1 backward). t = unit walking direction,
// s = distance actually walked (shorter if the line ends first)
function pointAlong(p, arc, i, dir, dist) {
  const n = p.length / 2;
  const target = arc[i] + dir * dist;
  let j = i;
  for (;;) {
    const k = j + dir;
    if (k < 0 || k >= n) break;
    if (dir > 0 ? arc[k] >= target : arc[k] <= target) {
      const segLen = Math.abs(arc[k] - arc[j]) || 1e-9;
      const f = Math.abs(target - arc[j]) / segLen;
      const dx = p[2 * k] - p[2 * j], dy = p[2 * k + 1] - p[2 * j + 1];
      return { x: p[2 * j] + dx * f, y: p[2 * j + 1] + dy * f, tx: dx / segLen, ty: dy / segLen, s: dist };
    }
    j = k;
  }
  // ran off the end: last point, direction of the last segment
  const k = j, h = j - dir;
  if (h < 0 || h >= n) return { x: p[2 * i], y: p[2 * i + 1], tx: 1, ty: 0, s: 0 };
  const dx = p[2 * k] - p[2 * h], dy = p[2 * k + 1] - p[2 * h + 1], l = Math.hypot(dx, dy) || 1;
  return { x: p[2 * k], y: p[2 * k + 1], tx: dx / l, ty: dy / l, s: Math.abs(arc[k] - arc[i]) };
}

// polyline shortened by d at both ends (null if too short)
function trimLine(p, d) {
  const n = p.length / 2;
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
  const total = arc[n - 1];
  if (total < 2 * d + 0.5) return null;
  const a = pointAlong(p, arc, 0, 1, d), b = pointAlong(p, arc, n - 1, -1, d);
  const out = [a.x, a.y];
  for (let i = 1; i < n - 1; i++) if (arc[i] > d && arc[i] < total - d) out.push(p[2 * i], p[2 * i + 1]);
  out.push(b.x, b.y);
  return out;
}

// convex hull of [[x,y],...], counter-clockwise
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
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
