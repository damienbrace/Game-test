// Ground ambient-occlusion map: a soft dark halo around building footprints
// and under tree canopies, rasterised once at load into a single-channel
// texture covering the built-up area. The ground shader multiplies its
// ambient light by it (and its sunlight a little), which gives buildings and
// trees a soft contact shadow at no per-frame cost.

import * as THREE from 'three';
import { ENV } from './materials.js';

export function buildAoMap(data, maxSize = 4096, mPerPx = 1.6) {
  const t0 = performance.now();
  // area covered: bounding box of buildings and trees, plus a margin
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const b of data.buildings) for (let i = 0; i < b.p.length; i += 2) grow(b.p[i], b.p[i + 1]);
  const T = data.trees || [];
  for (let k = 0; k < T.length; k += 3) grow(T[k], T[k + 1]);
  if (!isFinite(x0)) return null;
  x0 -= 40; y0 -= 40; x1 += 40; y1 += 40;
  const S = Math.max(x1 - x0, y1 - y0);
  const N = Math.min(maxSize, Math.pow(2, Math.ceil(Math.log2(S / mPerPx))));
  const mpp = S / N;

  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, N, N);
  const tx = (x) => (x - x0) / mpp, ty = (y) => (y1 - y) / mpp;

  // buildings, grouped by height: taller ones get a wider, darker halo
  const groups = [[0, 4.5, 2.4, 0.8], [4.5, 9, 3.5, 0.9], [9, 20, 5, 1], [20, 1e9, 7, 1]];
  for (const [h0, h1, blurM, a] of groups) {
    g.beginPath();
    let any = false;
    for (const b of data.buildings) {
      const h = b.h || 4;
      if (h < h0 || h >= h1 || b.k === 4) continue; // open roofs / carports: no wall contact
      const p = b.p;
      g.moveTo(tx(p[0]), ty(p[1]));
      for (let i = 2; i < p.length; i += 2) g.lineTo(tx(p[i]), ty(p[i + 1]));
      g.closePath();
      any = true;
    }
    if (!any) continue;
    g.save();
    g.fillStyle = `rgba(0,0,0,${a})`;
    g.shadowColor = `rgba(0,0,0,${a})`;
    g.shadowBlur = Math.max(1, blurM / mpp);
    g.fill();
    g.restore();
  }
  // open-sided roofs and carports: lighter shade underneath
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = Math.max(1, 1.5 / mpp);
  g.beginPath();
  for (const b of data.buildings) {
    if (b.k !== 4) continue;
    const p = b.p;
    g.moveTo(tx(p[0]), ty(p[1]));
    for (let i = 2; i < p.length; i += 2) g.lineTo(tx(p[i]), ty(p[i + 1]));
    g.closePath();
  }
  g.fill();
  g.restore();
  // trees: soft dark disc under the canopy
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.shadowColor = 'rgba(0,0,0,0.3)';
  g.shadowBlur = Math.max(1, 1.5 / mpp);
  g.beginPath();
  for (let k = 0; k < T.length; k += 3) {
    const r = (1.6 * T[k + 2]) / mpp;
    const cx = tx(T[k]), cy = ty(T[k + 1]);
    g.moveTo(cx + r, cy);
    g.arc(cx, cy, r, 0, Math.PI * 2);
  }
  g.fill();
  g.restore();

  const img = g.getImageData(0, 0, N, N).data;
  const a = new Uint8Array(N * N);
  for (let i = 0, j = 0; i < a.length; i++, j += 4) a[i] = img[j];
  const tex = new THREE.DataTexture(a, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  // row 0 is the top (y1) row: v = (y1 - y) / S; ground shader passes world
  // z (= -y) so v = (y1 + z) / S
  ENV.aoMap.value = tex;
  ENV.aoXform.value.set(x0, y1, 1 / S, 1 / S);
  ENV.aoStrength.value = 0.7;
  return { tex, N, mpp, ms: performance.now() - t0 };
}
