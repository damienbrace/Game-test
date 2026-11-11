// Small procedural textures generated at load (no image files, no network).
//
// detailTexture(): one 256x256 tileable RGBA texture, one surface per channel,
// each channel normalised to mean 0.5 so that a mip-mapped (distant) lookup
// averages to exactly 0.5 and the multiply in the ground shader fades to 1:
//   R = asphalt grain and aggregate, G = grass clumps, B = sand grain and
//   ripples, A = concrete / paving speckle and stains.

import * as THREE from 'three';

const N = 256;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tileable value noise: `cells` lattice cells across the texture
function valueNoise(cells, seed) {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(N * N);
  const s = cells / N;
  for (let y = 0; y < N; y++) {
    const fy = y * s, iy = Math.floor(fy), ty = fy - iy, uy = ty * ty * (3 - 2 * ty);
    const y0 = iy % cells, y1 = (iy + 1) % cells;
    for (let x = 0; x < N; x++) {
      const fx = x * s, ix = Math.floor(fx), tx = fx - ix, ux = tx * tx * (3 - 2 * tx);
      const x0 = ix % cells, x1 = (ix + 1) % cells;
      const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1], c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
      out[y * N + x] = (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
    }
  }
  return out;
}

function fbm(octaves, seed) {
  // octaves: [[cells, weight], ...]
  const out = new Float32Array(N * N);
  octaves.forEach(([cells, w], k) => {
    const n = valueNoise(cells, seed + k * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w;
  });
  return out;
}

function white(seed) {
  const r = rng(seed);
  const out = new Float32Array(N * N);
  for (let i = 0; i < out.length; i++) out[i] = r();
  return out;
}

// rescale to mean 0.5 and the given standard deviation, write into channel
function store(data, ch, v, std) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m);
  s = Math.sqrt(s / v.length) || 1;
  const k = std / s;
  // clamp, then re-centre so the stored mean is exactly 128
  const q = new Float32Array(v.length);
  let qm = 0;
  for (let i = 0; i < v.length; i++) { q[i] = Math.max(-0.5, Math.min(0.5, (v[i] - m) * k)); qm += q[i]; }
  qm /= v.length;
  for (let i = 0; i < v.length; i++) data[i * 4 + ch] = Math.max(0, Math.min(255, Math.round((0.5 + q[i] - qm) * 255)));
}

let detail = null;
export function detailTexture() {
  if (detail) return detail;
  const data = new Uint8Array(N * N * 4);
  const r = rng(7);

  // asphalt: pixel grain, small blotches, a few bright aggregate stones
  {
    const g = white(11), b = fbm([[8, 0.5], [32, 0.35], [64, 0.25]], 21);
    const v = new Float32Array(N * N);
    for (let i = 0; i < v.length; i++) v[i] = g[i] * 0.55 + b[i] * 0.7;
    for (let k = 0; k < 700; k++) {
      const x = Math.floor(r() * N), y = Math.floor(r() * N), br = 0.5 + r() * 0.6;
      v[y * N + x] += br;
      if (r() < 0.35) v[y * N + ((x + 1) % N)] += br * 0.6;
    }
    store(data, 0, v, 0.17);
  }
  // grass: clumps at a few scales plus fine blade noise
  {
    const c = fbm([[4, 0.6], [16, 0.5], [32, 0.45], [128, 0.35]], 31), g = white(37);
    const v = new Float32Array(N * N);
    for (let i = 0; i < v.length; i++) v[i] = c[i] + g[i] * 0.3;
    // darker tufts
    for (let k = 0; k < 260; k++) {
      const x0 = r() * N, y0 = r() * N, rad = 1.5 + r() * 3;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.hypot(dx, dy) / rad;
        if (d < 1) { const x = (Math.floor(x0) + dx + N) % N, y = (Math.floor(y0) + dy + N) % N; v[y * N + x] -= 0.35 * (1 - d); }
      }
    }
    store(data, 1, v, 0.16);
  }
  // sand: fine grain and soft wind ripples (warped stripes)
  {
    const g = white(41), w = fbm([[4, 1], [8, 0.5]], 43), m = fbm([[16, 1]], 47);
    const v = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const ph = ((14 * x + 5 * y) / N) * Math.PI * 2 + w[i] * 9; // integer wave counts keep it tileable
      v[i] = Math.sin(ph) * 0.35 + g[i] * 0.45 + m[i] * 0.4;
    }
    store(data, 2, v, 0.13);
  }
  // concrete / paving: speckle and soft stains
  {
    const g = white(51), s = fbm([[4, 0.6], [8, 0.5], [32, 0.25]], 53);
    const v = new Float32Array(N * N);
    for (let i = 0; i < v.length; i++) v[i] = g[i] * 0.35 + s[i];
    store(data, 3, v, 0.12);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  detail = tex;
  return tex;
}

export function setTextureAnisotropy(renderer, level) {
  const max = renderer.capabilities.getMaxAnisotropy();
  const want = Math.min(max, level === 'high' ? 8 : level === 'medium' ? 4 : 2);
  if (detail && detail.anisotropy !== want) { detail.anisotropy = want; detail.needsUpdate = true; }
}
