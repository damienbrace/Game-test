#!/usr/bin/env node
// Converts a raw Overpass JSON dump into the compact map file the game loads.
//
//   node tools/build-map.mjs <raw-overpass.json> [out=data/bunbury.json]
//
// Output coordinates are local metres around ORIGIN: x = east, y = north,
// rounded to 0.1 m. Only tags the game uses are kept. No dependencies.

import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = { lat: -33.3267, lon: 115.6370 };           // Bunbury CBD (Victoria St)
const BBOX = { s: -33.365, w: 115.612, n: -33.300, e: 115.690 }; // play area
const SEA_MARGIN = 1500;                                  // sea/big water extends past the play area (m)

const [, , inPath, outPath = 'data/bunbury.json'] = process.argv;
if (!inPath) {
  console.error('usage: node tools/build-map.mjs <raw-overpass.json> [out.json]');
  process.exit(1);
}

// ---------------------------------------------------------------- projection
const R = 6371008.8;
const D2R = Math.PI / 180;
const kx = Math.cos(ORIGIN.lat * D2R) * R * D2R;
const ky = R * D2R;
const proj = (lat, lon) => [(lon - ORIGIN.lon) * kx, (lat - ORIGIN.lat) * ky];
const r1 = (v) => Math.round(v * 10) / 10;

const [bx0, by0] = proj(BBOX.s, BBOX.w);
const [bx1, by1] = proj(BBOX.n, BBOX.e);
const PLAY = [bx0, by0, bx1, by1];
const CLIP = [bx0 - SEA_MARGIN, by0 - SEA_MARGIN, bx1 + SEA_MARGIN, by1 + SEA_MARGIN];

// ---------------------------------------------------------------- load
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const nodes = new Map();
const ways = new Map();
const rels = [];
for (const el of raw.elements) {
  if (el.type === 'node') nodes.set(el.id, el);
  else if (el.type === 'way') ways.set(el.id, el);
  else if (el.type === 'relation') rels.push(el);
}
const wayPts = (w) => {
  const out = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (n) out.push(proj(n.lat, n.lon));
  }
  return out;
};
const isClosed = (w) => w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];

// ---------------------------------------------------------------- geometry helpers
function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2; // >0 = counter-clockwise (y up)
}
function dropClosingDup(pts) {
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
  }
  return pts;
}
// Sutherland-Hodgman clip of a ring against an axis-aligned rectangle.
function clipRing(pts, [x0, y0, x1, y1]) {
  const edges = [
    (p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])],
    (p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])],
    (p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0],
    (p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1],
  ];
  let out = pts;
  for (let e = 0; e < 8; e += 2) {
    const inside = edges[e], cut = edges[e + 1];
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
    if (out.length < 3) return [];
  }
  return out;
}
// Liang-Barsky clip of a polyline: returns runs [{pts, startCut, endCut}]
function clipPolyline(pts, [x0, y0, x1, y1]) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { runs.push(cur); cur = null; } continue; }
    const A = [a[0] + dx * t0, a[1] + dy * t0], B = [a[0] + dx * t1, a[1] + dy * t1];
    if (!cur || t0 > 0) {
      if (cur) runs.push(cur);
      cur = { pts: [A], startCut: t0 > 0 || i > 0 };
    }
    cur.pts.push(B);
    if (t1 < 1) { cur.endCut = true; runs.push(cur); cur = null; }
  }
  if (cur) { cur.endCut = false; runs.push(cur); }
  return runs.filter((r) => r.pts.length >= 2);
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function distPointSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
// Join member ways of a multipolygon into closed rings (by node id).
function assembleRings(wayList) {
  const pool = wayList.map((w) => w.nodes.slice()).filter((n) => n.length >= 2);
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 1000) {
      const end = ring[ring.length - 1];
      const k = pool.findIndex((p) => p[0] === end || p[p.length - 1] === end);
      if (k < 0) break;
      const p = pool.splice(k, 1)[0];
      ring = ring.concat(p[0] === end ? p.slice(1) : p.reverse().slice(1));
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) {
      const pts = ring.map((id) => nodes.get(id)).filter(Boolean).map((n) => proj(n.lat, n.lon));
      rings.push(pts);
    }
  }
  return rings;
}
const flat = (pts) => {
  const out = [];
  for (const p of pts) out.push(r1(p[0]), r1(p[1]));
  return out;
};
// Polygons: list of rings (first outer, rest holes); outer CCW, holes CW.
function clipPolygon(outer, holes, box) {
  let o = clipRing(dropClosingDup(outer), box);
  if (o.length < 3 || Math.abs(signedArea(o)) < 1) return null;
  if (signedArea(o) < 0) o.reverse();
  const hs = [];
  for (const h of holes) {
    let c = clipRing(dropClosingDup(h), box);
    if (c.length < 3) continue;
    if (signedArea(c) > 0) c.reverse();
    hs.push(c);
  }
  return [o, ...hs];
}
const polyOut = (poly) => poly.map(flat);

// ---------------------------------------------------------------- collect areas
const areas = { water: [], sand: [], park: [], grass: [], wood: [], pitch: [], parking: [], pier: [], land: [] };

function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.landuse === 'basin' || t.landuse === 'reservoir' || (t.water && t.natural !== 'wetland')) return 'water';
  if (t.natural === 'beach' || t.natural === 'sand') return 'sand';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'scrub' || t.natural === 'wetland') return 'wood';
  if (t.leisure === 'pitch' || t.leisure === 'sports_centre' || t.leisure === 'stadium') return 'pitch';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'golf_course' || t.leisure === 'recreation_ground' || t.leisure === 'playground' || t.landuse === 'recreation_ground' || t.landuse === 'village_green') return 'park';
  if (t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'cemetery' || t.natural === 'grassland') return 'grass';
  if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') return 'parking';
  if (t.man_made === 'pier') return 'pier';
  return null;
}

// harbour / marina / dock basins get a quay edge in the game
const isHarbour = (t) => t.waterway === 'dock' || t.leisure === 'marina' || /harbou?r|marina|dock/i.test(t.name || '');
const quays = [];
const relMemberWays = new Set();
for (const r of rels) {
  const t = r.tags || {};
  if (t.type !== 'multipolygon') continue;
  const kind = t.building ? null : areaKind(t);
  if (!kind) continue;
  const outerW = [], innerW = [];
  for (const m of r.members) {
    if (m.type !== 'way') continue;
    const w = ways.get(m.ref);
    if (!w) continue;
    relMemberWays.add(w.id);
    (m.role === 'inner' ? innerW : outerW).push(w);
  }
  const outers = assembleRings(outerW), inners = assembleRings(innerW);
  const box = kind === 'water' ? CLIP : PLAY;
  for (const o of outers) {
    const hs = inners.filter((h) => h.length && pointInRing(h[0][0], h[0][1], o));
    const p = clipPolygon(o, hs, box);
    if (p) {
      areas[kind].push(p);
      if (kind === 'water' && isHarbour(t)) quays.push(flat(p[0]));
    }
  }
}
const pierLines = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!t || t.building || t.highway) continue;
  const kind = areaKind(t);
  if (!kind) continue;
  if (kind === 'pier' && !(isClosed(w) && t.area !== 'no')) {
    const runs = clipPolyline(wayPts(w), PLAY);
    for (const run of runs) pierLines.push({ w: parseFloat(t.width) || 4, p: flat(run.pts) });
    continue;
  }
  if (!isClosed(w)) continue;
  if (relMemberWays.has(w.id) && !t.natural && !t.leisure && !t.landuse) continue;
  const p = clipPolygon(wayPts(w), [], kind === 'water' ? CLIP : PLAY);
  if (p) {
    areas[kind].push(p);
    if (kind === 'water' && isHarbour(t)) quays.push(flat(p[0]));
  }
}

// ---------------------------------------------------------------- coastline -> sea polygons
// OSM convention: land is on the LEFT of a coastline way's direction, so the
// sea is on the right. Pieces are clipped to CLIP; each piece runs from an
// entry point on the box boundary to an exit point. A sea polygon is traced by
// walking a piece backwards (exit -> entry, sea now on the left) and then
// continuing counter-clockwise along the box boundary (box interior on the
// left) until the next exit point, and so on until the loop closes.
function buildSea() {
  const [x0, y0, x1, y1] = CLIP;
  const W = x1 - x0, H = y1 - y0, P = 2 * (W + H);
  const eps = 0.01;
  const perim = ([x, y]) => {
    if (Math.abs(y - y0) < eps) return x - x0;
    if (Math.abs(x - x1) < eps) return W + (y - y0);
    if (Math.abs(y - y1) < eps) return W + H + (x1 - x);
    if (Math.abs(x - x0) < eps) return 2 * W + H + (y1 - y);
    return null;
  };
  const corners = [[0, [x0, y0]], [W, [x1, y0]], [W + H, [x1, y1]], [2 * W + H, [x0, y1]]];
  const coastWays = [...ways.values()].filter((w) => w.tags && w.tags.natural === 'coastline');
  // merge coastline ways end-to-end first (same direction by convention)
  let chains = coastWays.map((w) => w.nodes.slice());
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i++) {
      for (let j = 0; j < chains.length && !merged; j++) {
        if (i !== j && chains[i][chains[i].length - 1] === chains[j][0] && chains[i][0] !== chains[i][chains[i].length - 1]) {
          chains[i] = chains[i].concat(chains[j].slice(1));
          chains.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  const pieces = [];
  const sea = [], land = [], coastLines = [];
  for (const ch of chains) {
    const pts = ch.map((id) => nodes.get(id)).filter(Boolean).map((n) => proj(n.lat, n.lon));
    const closed = ch[0] === ch[ch.length - 1];
    coastLines.push(pts);
    if (closed && pts.every(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) {
      // island (CCW) or enclosed sea (CW)
      const ring = dropClosingDup(pts);
      if (signedArea(ring) > 0) land.push([ring]); else sea.push([ring.reverse()]);
      continue;
    }
    for (const run of clipPolyline(pts, CLIP)) {
      const sIn = perim(run.pts[0]), sOut = perim(run.pts[run.pts.length - 1]);
      if (sIn === null || sOut === null) { console.warn('coastline piece does not reach the clip box; skipped'); continue; }
      pieces.push({ pts: run.pts, sIn, sOut, used: false });
    }
  }
  const fwd = (a, b) => ((b - a) % P + P) % P; // CCW distance from a to b
  for (const start of pieces) {
    if (start.used) continue;
    const ring = [];
    let piece = start;
    let guard = 0;
    while (guard++ < 100) {
      piece.used = true;
      for (let i = piece.pts.length - 1; i >= 0; i--) ring.push(piece.pts[i]);
      const s = piece.sIn;
      let best = null, bestD = Infinity;
      for (const p of pieces) {
        const d = fwd(s, p.sOut);
        const dd = d === 0 ? P : d;
        if (dd < bestD && (!p.used || p === start)) { bestD = dd; best = p; }
      }
      for (const [cs, cp] of corners.map(([c, p]) => [fwd(s, c), p]).sort((a, b) => a[0] - b[0])) {
        if (cs > 0 && cs < bestD) ring.push(cp);
      }
      if (best === start || !best) break;
      piece = best;
    }
    sea.push([ring]);
  }
  return { sea, land, coastLines };
}
const { sea, land, coastLines } = buildSea();
areas.land.push(...land);

// ---------------------------------------------------------------- coast edge kinds
// OSM has no tag for "this shore is a beach" unless natural=beach is mapped,
// so each coastline segment is classified from the geometry:
//   0 beach  - inside / next to a mapped beach or sand area, or an open-ocean
//              shore (most rays cast seaward travel 2.5 km without meeting land)
//   1 hard   - sheltered shore (harbour, marina, bay edges): rock / seawall
//   2 mole   - land narrower than ~70 m behind the shore (breakwaters,
//              groynes, harbour walls): rock armour
// Runs shorter than 50 m are merged into their neighbours.
const COAST_KIND = { beach: 0, hard: 1, mole: 2 };
function classifyCoast() {
  const segs = [];
  for (const pts of coastLines) for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  const SG = 200, sgrid = new Map();
  segs.forEach((s, si) => {
    for (let gx = Math.floor(Math.min(s[0][0], s[1][0]) / SG); gx <= Math.floor(Math.max(s[0][0], s[1][0]) / SG); gx++)
      for (let gy = Math.floor(Math.min(s[0][1], s[1][1]) / SG); gy <= Math.floor(Math.max(s[0][1], s[1][1]) / SG); gy++) {
        const k = gx * 100000 + gy;
        if (!sgrid.has(k)) sgrid.set(k, []);
        sgrid.get(k).push(si);
      }
  });
  // distance along the ray (ox,oy)+t(dx,dy), t in (0,maxT], to the first coast segment
  const rayHit = (ox, oy, dx, dy, maxT) => {
    let best = Infinity;
    const steps = Math.ceil(maxT / (SG / 2));
    const seen = new Set();
    for (let k = 0; k <= steps && best === Infinity; k++) {
      const cx = ox + dx * k * SG / 2, cy = oy + dy * k * SG / 2;
      for (let gx = Math.floor(cx / SG) - 1; gx <= Math.floor(cx / SG) + 1; gx++) for (let gy = Math.floor(cy / SG) - 1; gy <= Math.floor(cy / SG) + 1; gy++) {
        for (const si of sgrid.get(gx * 100000 + gy) || []) {
          if (seen.has(si)) continue;
          seen.add(si);
          const [a, b] = segs[si];
          const ex = b[0] - a[0], ey = b[1] - a[1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((a[0] - ox) * ey - (a[1] - oy) * ex) / den;
          const u = ((a[0] - ox) * dy - (a[1] - oy) * dx) / den;
          if (t > 1e-3 && t <= maxT && u >= 0 && u <= 1 && t < best) best = t;
        }
      }
    }
    return best;
  };
  const sandBB = areas.sand.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const q of p[0]) { a = Math.min(a, q[0]); c = Math.max(c, q[0]); b = Math.min(b, q[1]); d = Math.max(d, q[1]); }
    return [a - 30, b - 30, c + 30, d + 30];
  });
  const nearSand = (x, y) => {
    for (let i = 0; i < areas.sand.length; i++) {
      const bb = sandBB[i];
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      const ring = areas.sand[i][0];
      if (pointInRing(x, y, ring)) return true;
      for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) if (distPointSeg(x, y, ring[k], ring[j]) < 30) return true;
    }
    return false;
  };
  const out = [];
  for (const pts of coastLines) {
    for (const run of clipPolyline(pts, PLAY)) {
      const p = run.pts;
      const kinds = [], lens = [];
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
        const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        // land on the left, sea on the right
        const lx = -ty, ly = tx;
        let k;
        if (nearSand(mx, my)) k = COAST_KIND.beach;
        else {
          const thick = Math.min(
            rayHit(mx + lx * 0.3, my + ly * 0.3, lx, ly, 120),
            rayHit(mx + lx * 0.3, my + ly * 0.3, lx * 0.94 + tx * 0.34, ly * 0.94 + ty * 0.34, 120),
            rayHit(mx + lx * 0.3, my + ly * 0.3, lx * 0.94 - tx * 0.34, ly * 0.94 - ty * 0.34, 120),
          );
          if (thick < 70) k = COAST_KIND.mole;
          else {
            let open = 0;
            for (let q = -5; q <= 5; q++) {
              const ang = q * 0.17; // +-50 degrees around the seaward normal
              const c = Math.cos(ang), s = Math.sin(ang);
              const dx = -lx * c - tx * s, dy = -ly * c - ty * s;
              if (rayHit(mx - lx * 0.3, my - ly * 0.3, dx, dy, 2500) === Infinity) open++;
            }
            k = open >= 8 ? COAST_KIND.beach : COAST_KIND.hard;
          }
        }
        kinds.push(k);
        lens.push(len);
      }
      // merge short runs into the longer neighbour, repeatedly
      for (let pass = 0; pass < 4; pass++) {
        let i = 0;
        while (i < kinds.length) {
          let j = i, L = 0;
          while (j < kinds.length && kinds[j] === kinds[i]) L += lens[j++];
          if (L < 50 && (i > 0 || j < kinds.length)) {
            const prev = i > 0 ? kinds[i - 1] : kinds[j];
            const next = j < kinds.length ? kinds[j] : prev;
            for (let q = i; q < j; q++) kinds[q] = prev === next ? prev : (i > 0 ? prev : next);
          }
          i = j;
        }
      }
      let s = 0;
      for (let i = 1; i <= kinds.length; i++) {
        if (i === kinds.length || kinds[i] !== kinds[s]) {
          out.push({ k: kinds[s], p: flat(p.slice(s, i + 1)) });
          s = i;
        }
      }
    }
  }
  return out;
}
const coast = classifyCoast();

// ---------------------------------------------------------------- roads
const CLASSES = ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track', 'path'];
const classOf = (h) => {
  const base = h.replace(/_link$/, '');
  if (base === 'motorway' || base === 'trunk') return 0;
  if (base === 'primary') return 1;
  if (base === 'secondary') return 2;
  if (base === 'tertiary') return 3;
  if (base === 'unclassified' || base === 'road') return 4;
  if (base === 'residential' || base === 'living_street') return 5;
  if (base === 'service') return 6;
  if (base === 'track') return 7;
  if (['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway'].includes(base)) return 8;
  return -1;
};
const BASE_W = [11, 10, 9, 8, 7, 6.5, 4.2, 3.5, 2.2];
const names = [];
const nameIdx = new Map();
const nameId = (n) => {
  if (!n) return -1;
  if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
  return nameIdx.get(n);
};
// junction nodes: used more than once among drivable roads
const nodeUse = new Map();
const roadWays = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!t || !t.highway || t.area === 'yes') continue;
  const c = classOf(t.highway);
  if (c < 0) continue;
  if (t.tunnel && t.tunnel !== 'no') continue;
  roadWays.push([w, c]);
  if (c < 8) for (const id of new Set(w.nodes)) nodeUse.set(id, (nodeUse.get(id) || 0) + 1);
  if (c < 8 && w.nodes[0] === w.nodes[w.nodes.length - 1]) nodeUse.set(w.nodes[0], 2);
}
function roadWidth(t, c) {
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout';
  let width = parseFloat(t.width);
  if (!(width > 1.5 && width < 40)) {
    const lanes = parseInt(t.lanes, 10);
    if (lanes > 0 && lanes < 8 && c < 7) width = lanes * 3.3 + (c <= 2 ? 1 : 0.4);
    else width = BASE_W[c] * (oneway && c <= 4 ? 0.62 : 1);
  }
  return Math.min(width, 16);
}

// Roundabouts: join the roundabout ways into closed rings. A ring that is
// star-shaped around its centroid is stored as a centre plus a radius profile
// (RB_N samples); the game draws it as a smooth annulus with a round island,
// and its ways are flagged r=2 so they are not drawn again as strips.
const RB_N = 36;
const roundabouts = [];
const ringWayIds = new Set();
{
  const rw = roadWays.filter(([w, c]) => w.tags.junction === 'roundabout' && c < 8);
  const pool = rw.map(([w, c]) => ({ ids: [w.id], nodes: w.nodes.slice(), c, wd: roadWidth(w.tags, c), lanes: parseInt(w.tags.lanes, 10) || 0 }));
  const rings = [];
  while (pool.length) {
    const ring = pool.shift();
    let guard = 0;
    while (ring.nodes[0] !== ring.nodes[ring.nodes.length - 1] && guard++ < 100) {
      const end = ring.nodes[ring.nodes.length - 1];
      const k = pool.findIndex((p) => p.nodes[0] === end);
      if (k < 0) break;
      const p = pool.splice(k, 1)[0];
      ring.nodes = ring.nodes.concat(p.nodes.slice(1));
      ring.ids.push(...p.ids);
      ring.c = Math.min(ring.c, p.c);
      ring.wd = Math.max(ring.wd, p.wd);
      ring.lanes = Math.max(ring.lanes, p.lanes);
    }
    if (ring.nodes[0] === ring.nodes[ring.nodes.length - 1] && ring.nodes.length >= 5) rings.push(ring);
  }
  for (const ring of rings) {
    const pts = dropClosingDup(ring.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => proj(n.lat, n.lon)));
    if (pts.length < 4) continue;
    // area centroid
    let A = 0, cx = 0, cy = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      A += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
    }
    if (Math.abs(A) < 1e-6) continue;
    cx /= 3 * A; cy /= 3 * A;
    if (cx < PLAY[0] || cx > PLAY[2] || cy < PLAY[1] || cy > PLAY[3]) continue;
    const rad = [];
    let ok = true;
    for (let s = 0; s < RB_N && ok; s++) {
      const a = (s / RB_N) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      const hits = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const P = pts[j], Q = pts[i];
        const ex = Q[0] - P[0], ey = Q[1] - P[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((P[0] - cx) * ey - (P[1] - cy) * ex) / den;
        const u = ((P[0] - cx) * dy - (P[1] - cy) * dx) / den;
        if (t > 0 && u >= 0 && u < 1) hits.push(t);
      }
      if (hits.length !== 1) ok = false; else rad.push(hits[0]);
    }
    if (!ok) continue;
    const mean = rad.reduce((a, b) => a + b, 0) / rad.length;
    if (mean < 4 || mean > 70 || mean - ring.wd / 2 < 1.5) continue;
    // light smoothing of the radius profile (OSM rings are coarse polygons)
    const sm = rad.map((_, i) => (rad[(i + RB_N - 1) % RB_N] + 2 * rad[i] + rad[(i + 1) % RB_N]) / 4);
    for (const id of ring.ids) ringWayIds.add(id);
    const o = { x: r1(cx), y: r1(cy), w: r1(ring.wd), c: ring.c, rr: sm.map(r1) };
    if (ring.lanes >= 2) o.l = ring.lanes;
    roundabouts.push(o);
  }
}

const roads = [];
for (const [w, c] of roadWays) {
  const t = w.tags;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout';
  const width = roadWidth(t, c);
  // clip to play area, tracking which vertices are junctions
  const pts = [], junc = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    pts.push(proj(n.lat, n.lon));
    junc.push((nodeUse.get(id) || 0) > 1);
  }
  const allIn = pts.every(([x, y]) => x >= PLAY[0] && x <= PLAY[2] && y >= PLAY[1] && y <= PLAY[3]);
  const runs = allIn ? [{ pts, junc }] : clipPolyline(pts, PLAY).map((r) => ({ pts: r.pts, junc: null }));
  for (const run of runs) {
    let j = [];
    if (run.junc) run.junc.forEach((v, i) => v && j.push(i));
    else {
      // map junction flags by exact coordinate match after clipping
      const jset = new Set();
      pts.forEach((p, i) => junc[i] && jset.add(p[0] + ',' + p[1]));
      run.pts.forEach((p, i) => jset.has(p[0] + ',' + p[1]) && j.push(i));
    }
    const r = { c, w: r1(width), p: flat(run.pts) };
    const n = nameId(t.name || (c <= 1 && t.ref ? t.ref : ''));
    if (n >= 0) r.n = n;
    if (oneway) r.o = 1;
    if (t.bridge && t.bridge !== 'no') r.b = 1;
    if (t.junction === 'roundabout') r.r = ringWayIds.has(w.id) ? 2 : 1;
    const lanes = parseInt(t.lanes, 10);
    if (c < 8 && lanes >= (oneway ? 2 : 3) && lanes < 8) r.l = lanes;
    if (t.surface && /unpaved|gravel|dirt|sand|ground|grass|compacted/.test(t.surface)) r.u = 1;
    if (j.length) r.j = j;
    roads.push(r);
  }
}

// ---------------------------------------------------------------- rail
const rail = [], railBridges = [];
for (const w of ways.values()) {
  if (w.tags && w.tags.railway === 'rail' && !(w.tags.tunnel && w.tags.tunnel !== 'no')) {
    const br = w.tags.bridge && w.tags.bridge !== 'no';
    for (const run of clipPolyline(wayPts(w), PLAY)) (br ? railBridges : rail).push(flat(run.pts));
  }
}

// ---------------------------------------------------------------- rivers
// waterway=river/canal centrelines (e.g. the Preston River); drawn as water
// strips so the bridges over them cross something.
const rivers = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!t || !(t.waterway === 'river' || t.waterway === 'canal') || (t.tunnel && t.tunnel !== 'no')) continue;
  let wd = parseFloat(t.width);
  if (!(wd > 2 && wd < 200)) wd = t.waterway === 'river' ? 24 : 8;
  for (const run of clipPolyline(wayPts(w), PLAY)) rivers.push({ w: r1(wd), p: flat(run.pts) });
}

// ---------------------------------------------------------------- sports pitches
// Line markings need the pitch's orientation and size: store the minimum-area
// bounding rectangle of each pitch whose sport has markings we can draw.
const SPORTS = { australian_football: 'afl', cricket: 'cricket', soccer: 'soccer', rugby_union: 'rugby', rugby_league: 'rugby', tennis: 'tennis', basketball: 'basketball', netball: 'netball', hockey: 'hockey', field_hockey: 'hockey' };
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const sports = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!t || t.leisure !== 'pitch' || !isClosed(w)) continue;
  const sp = SPORTS[(t.sport || '').split(';')[0]];
  if (!sp) continue;
  const hull = convexHull(dropClosingDup(wayPts(w)));
  if (hull.length < 3) continue;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const u = q[0] * ux + q[1] * uy, v = -q[0] * uy + q[1] * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) continue;
  let { ux, uy, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const x = cu * ux - cv * uy, y = cu * uy + cv * ux;
  if (x < PLAY[0] || x > PLAY[2] || y < PLAY[1] || y > PLAY[3]) continue;
  let L = u1 - u0, W = v1 - v0, a = Math.atan2(uy, ux);
  if (W > L) { [L, W] = [W, L]; a += Math.PI / 2; }
  a = Math.atan2(Math.sin(a), Math.cos(a));
  if (a < 0) a += Math.PI;
  if (L < 8) continue;
  sports.push({ s: sp, x: r1(x), y: r1(y), a: Math.round(a * 1000) / 1000, L: r1(L), W: r1(W) });
}

// ---------------------------------------------------------------- buildings
function buildingHeight(t, kind) {
  const h = parseFloat(t.height);
  if (h > 1 && h < 200) return h;
  const lv = parseFloat(t['building:levels']);
  if (lv > 0 && lv < 60) return lv * 3.2 + 1;
  const d = {
    house: 4.5, detached: 4.5, semidetached_house: 4.5, bungalow: 4.2, residential: 5, terrace: 6,
    apartments: 12, commercial: 7.5, retail: 6.5, office: 9, supermarket: 7, industrial: 8, warehouse: 8,
    cathedral: 16, church: 11, school: 6.5, hospital: 14, hotel: 15, garage: 3, garages: 3, shed: 3, carport: 2.8,
    hut: 3, kiosk: 3, roof: 4, train_station: 6, pavilion: 5, construction: 5, silo: 28, storage_tank: 12, gasometer: 12,
    tower: 14, lighthouse: 25,
  }[kind];
  return d || 5;
}
const BKINDS = ['house', 'commercial', 'industrial', 'civic', 'roof', 'shed', 'silo', 'tank', 'tower'];
function bkindIdx(kind) {
  if (['house', 'detached', 'semidetached_house', 'bungalow', 'residential', 'terrace', 'apartments'].includes(kind)) return 0;
  if (['commercial', 'retail', 'office', 'supermarket', 'hotel'].includes(kind)) return 1;
  if (['industrial', 'warehouse', 'construction'].includes(kind)) return 2;
  if (['cathedral', 'church', 'school', 'hospital', 'train_station', 'pavilion', 'civic', 'public'].includes(kind)) return 3;
  if (kind === 'roof' || kind === 'carport') return 4;
  if (['garage', 'garages', 'shed', 'hut', 'kiosk'].includes(kind)) return 5;
  if (kind === 'silo') return 6;
  if (kind === 'storage_tank' || kind === 'gasometer') return 7;
  if (kind === 'tower') return 8;
  return 0;
}
const rawBuildings = [];
const pois = [];
function addBuilding(t, outer, holes) {
  outer = dropClosingDup(outer);
  if (outer.length < 3) return;
  let cx = 0, cy = 0;
  for (const p of outer) { cx += p[0]; cy += p[1]; }
  cx /= outer.length; cy /= outer.length;
  if (cx < PLAY[0] || cx > PLAY[2] || cy < PLAY[1] || cy > PLAY[3]) return;
  let kind = t.building && t.building !== 'yes' ? t.building : (t.man_made || 'yes');
  if (t.man_made === 'lighthouse') {
    let rr = 0;
    for (const p of outer) rr = Math.max(rr, Math.hypot(p[0] - cx, p[1] - cy));
    pois.push({ t: 'lighthouse', x: r1(cx), y: r1(cy), r: r1(Math.max(2, Math.min(rr, 5))), h: buildingHeight(t, 'lighthouse') });
    return;
  }
  if (t.man_made === 'silo' || t.man_made === 'storage_tank' || t.man_made === 'gasometer' || t.man_made === 'tower') kind = t.man_made;
  if (signedArea(outer) < 0) outer.reverse();
  holes = holes.map((h) => { h = dropClosingDup(h); if (signedArea(h) > 0) h.reverse(); return h; }).filter((h) => h.length >= 3);
  rawBuildings.push({ t, kind, outer, holes, cx, cy, h: buildingHeight(t, kind) });
}
for (const w of ways.values()) {
  const t = w.tags;
  if (!t || !isClosed(w)) continue;
  if (t.building || ['silo', 'storage_tank', 'gasometer', 'lighthouse'].includes(t.man_made)) {
    if (relMemberWays.has(w.id) && !t.building) continue;
    if (t.building === 'no') continue;
    addBuilding(t, wayPts(w), []);
  }
}
for (const n of nodes.values()) {
  if (n.tags && n.tags.man_made === 'lighthouse') {
    const [x, y] = proj(n.lat, n.lon);
    if (x >= PLAY[0] && x <= PLAY[2] && y >= PLAY[1] && y <= PLAY[3]) pois.push({ t: 'lighthouse', x: r1(x), y: r1(y), r: 3, h: parseFloat(n.tags.height) || 25 });
  }
}
for (const r of rels) {
  const t = r.tags || {};
  if (!t.building) continue;
  const outerW = [], innerW = [];
  for (const m of r.members) {
    const w = m.type === 'way' && ways.get(m.ref);
    if (w) (m.role === 'inner' ? innerW : outerW).push(w);
  }
  const outers = assembleRings(outerW), inners = assembleRings(innerW);
  for (const o of outers) addBuilding(t, o, inners.filter((h) => pointInRing(h[0][0], h[0][1], o)));
}

// Drop buildings that a drivable road centreline passes through (covered
// carparks, data overlaps): otherwise the car would be blocked on a road.
const GRID = 50;
const segGrid = new Map();
const gkey = (gx, gy) => gx * 100000 + gy;
for (const r of roads) {
  if (r.c >= 8) continue;
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const a = [r.p[i], r.p[i + 1]], b = [r.p[i + 2], r.p[i + 3]];
    const gx0 = Math.floor(Math.min(a[0], b[0]) / GRID), gx1 = Math.floor(Math.max(a[0], b[0]) / GRID);
    const gy0 = Math.floor(Math.min(a[1], b[1]) / GRID), gy1 = Math.floor(Math.max(a[1], b[1]) / GRID);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gkey(gx, gy);
      if (!segGrid.has(k)) segGrid.set(k, []);
      segGrid.get(k).push([a, b, r]);
    }
  }
}
let droppedOnRoad = 0;
const buildings = [];
for (const b of rawBuildings) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of b.outer) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
  b.bb = [minx, miny, maxx, maxy];
  let hit = false;
  if (b.kind !== 'roof' && b.kind !== 'carport') {
    const seen = new Set();
    outer: for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++) for (let gy = Math.floor(miny / GRID); gy <= Math.floor(maxy / GRID); gy++) {
      for (const s of segGrid.get(gkey(gx, gy)) || []) {
        if (seen.has(s)) continue;
        seen.add(s);
        const [a, c] = s;
        if (pointInRing((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, b.outer) || pointInRing(a[0], a[1], b.outer)) { hit = true; break outer; }
        for (let i = 0, j = b.outer.length - 1; i < b.outer.length; j = i++) {
          if (segsIntersect(a, c, b.outer[j], b.outer[i])) { hit = true; break; }
        }
        if (hit) break outer;
      }
    }
  }
  if (hit) { droppedOnRoad++; continue; }
  const o = { h: r1(b.h), k: bkindIdx(b.kind), p: flat(b.outer) };
  if (b.holes.length) o.i = b.holes.map(flat);
  buildings.push(o);
}

// ---------------------------------------------------------------- trees
// Deterministic scatter inside woods/scrub (dense) and parks (sparse), kept
// away from roads, paths, pitches, water and buildings.
let seed = 1234567;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const bGrid = new Map();
for (const b of buildings) {
  const pts = [];
  for (let i = 0; i < b.p.length; i += 2) pts.push([b.p[i], b.p[i + 1]]);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
  for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++) for (let gy = Math.floor(miny / GRID); gy <= Math.floor(maxy / GRID); gy++) {
    const k = gkey(gx, gy);
    if (!bGrid.has(k)) bGrid.set(k, []);
    bGrid.get(k).push(pts);
  }
}
const allRoadSegs = new Map();
for (const r of [...roads, ...rivers]) {
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const a = [r.p[i], r.p[i + 1]], b = [r.p[i + 2], r.p[i + 3]];
    const gx0 = Math.floor((Math.min(a[0], b[0]) - 10) / GRID), gx1 = Math.floor((Math.max(a[0], b[0]) + 10) / GRID);
    const gy0 = Math.floor((Math.min(a[1], b[1]) - 10) / GRID), gy1 = Math.floor((Math.max(a[1], b[1]) + 10) / GRID);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gkey(gx, gy);
      if (!allRoadSegs.has(k)) allRoadSegs.set(k, []);
      allRoadSegs.get(k).push([a, b, r.w]);
    }
  }
}
const blockers = [...areas.water, ...areas.pitch, ...areas.parking, ...areas.sand, ...sea];
const blockerBB = blockers.map((p) => {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const q of p[0]) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); }
  return [minx, miny, maxx, maxy];
});
function treeOk(x, y) {
  const k = gkey(Math.floor(x / GRID), Math.floor(y / GRID));
  for (const [a, b, w] of allRoadSegs.get(k) || []) if (distPointSeg(x, y, a, b) < w / 2 + 2.5) return false;
  for (const ring of bGrid.get(k) || []) if (pointInRing(x, y, ring)) return false;
  for (let i = 0; i < blockers.length; i++) {
    const bb = blockerBB[i];
    if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
    const p = blockers[i];
    if (pointInRing(x, y, p[0]) && !p.slice(1).some((h) => pointInRing(x, y, h))) return false;
  }
  return true;
}
const trees = [];
const MAX_TREES = 7000;
const scatter = (polys, spacing, maxPer) => {
  for (const poly of polys) {
    const ring = poly[0];
    const area = Math.abs(signedArea(ring));
    let n = Math.min(maxPer, Math.floor(area / (spacing * spacing)));
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const q of ring) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); }
    let tries = n * 4;
    while (n > 0 && tries-- > 0 && trees.length < MAX_TREES * 3) {
      const x = minx + rand() * (maxx - minx), y = miny + rand() * (maxy - miny);
      if (!pointInRing(x, y, ring) || poly.slice(1).some((h) => pointInRing(x, y, h))) continue;
      if (!treeOk(x, y)) continue;
      trees.push(Math.round(x * 2) / 2, Math.round(y * 2) / 2, Math.round((0.75 + rand() * 0.6) * 100) / 100);
      n--;
    }
  }
};
scatter(areas.wood, 14, 400);
scatter(areas.park, 26, 80);
scatter(areas.grass, 34, 30);
if (trees.length > MAX_TREES * 3) trees.length = MAX_TREES * 3;

// ---------------------------------------------------------------- spawn
// nearest point on Victoria Street to the requested spawn
const [sx, sy] = proj(-33.3267, 115.6370);
let spawn = null, bestD = Infinity;
for (const r of roads) {
  if (names[r.n] !== 'Victoria Street') continue;
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const a = [r.p[i], r.p[i + 1]], b = [r.p[i + 2], r.p[i + 3]];
    const d = distPointSeg(sx, sy, a, b);
    if (d < bestD) {
      bestD = d;
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = Math.max(0.1, Math.min(0.9, ((sx - a[0]) * dx + (sy - a[1]) * dy) / l2));
      spawn = { x: r1(a[0] + dx * t), y: r1(a[1] + dy * t), dx: dx / Math.sqrt(l2), dy: dy / Math.sqrt(l2) };
    }
  }
}
if (spawn) {
  // face roughly north along the street
  if (spawn.dy < 0) { spawn.dx = -spawn.dx; spawn.dy = -spawn.dy; }
  spawn.dx = Math.round(spawn.dx * 1000) / 1000;
  spawn.dy = Math.round(spawn.dy * 1000) / 1000;
} else spawn = { x: 0, y: 0, dx: 0, dy: 1 };

// ---------------------------------------------------------------- write
const out = {
  v: 1,
  credit: '© OpenStreetMap contributors (ODbL)',
  osmTimestamp: raw.osm3s && raw.osm3s.timestamp_osm_base,
  origin: [ORIGIN.lat, ORIGIN.lon],
  bounds: PLAY.map(r1),
  clip: CLIP.map(r1),
  spawn,
  classes: CLASSES,
  buildingKinds: BKINDS,
  names,
  roads,
  rail,
  railBridges,
  sea: sea.map(polyOut),
  coast,
  areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.map(polyOut)])),
  piers: pierLines,
  roundabouts,
  rivers,
  quays,
  sports,
  buildings,
  trees,
  pois,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(outPath, json);
console.log(`wrote ${outPath}: ${(json.length / 1024).toFixed(0)} KB`);
console.log(`roads ${roads.length} (named ${roads.filter((r) => r.n !== undefined).length}, drivable ${roads.filter((r) => r.c < 8).length}), names ${names.length}`);
console.log(`buildings ${buildings.length} (dropped ${droppedOnRoad} crossed by roads), trees ${trees.length / 3}, rail ${rail.length}, piers ${pierLines.length}, pois ${pois.length}`);
console.log(`coast runs ${coast.length} (m by kind beach/hard/mole: ${[0, 1, 2].map((k) => Math.round(coast.filter((c) => c.k === k).reduce((s, c) => { let L = 0; for (let i = 2; i < c.p.length; i += 2) L += Math.hypot(c.p[i] - c.p[i - 2], c.p[i + 1] - c.p[i - 1]); return s + L; }, 0))).join('/')}), roundabouts ${roundabouts.length}, rivers ${rivers.length}, sports ${sports.length}`);
console.log('sea polys', sea.length, 'sea ring pts', sea.map((p) => p[0].length), 'land', land.length);
console.log('areas', Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.length])));
console.log('spawn', spawn, 'bounds', out.bounds);
