// Sun, sky light and the moving shadow map.
//
// setSun(elevation, azimuth) derives every colour from the sun position
// (sun colour / intensity, sky zenith and horizon, haze, hemisphere light,
// fog), so time of day can be animated later by calling it each frame.
//
// The sun's shadow map is one orthographic map centred a little ahead of the
// camera. Its centre is snapped to whole shadow-map texels in light space,
// so static shadows do not shimmer or crawl while driving. Shadows fade out
// towards the edge of the map (see materials.js).

import * as THREE from 'three';
import { ENV, FOG_SUN } from './materials.js';

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mixC = (out, a, b, t) => out.setRGB(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));

export class Lighting {
  constructor(scene) {
    this.scene = scene;
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.shadow.autoUpdate = true;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x808060, 1.8);
    scene.add(this.hemi);
    scene.fog = new THREE.Fog(0xffffff, 260, 1050);
    this.dir = new THREE.Vector3(0, 1, 0);
    this.ex = new THREE.Vector3();
    this.ey = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.debugOffset = new THREE.Vector3(); // tests: shift the shadow focus
    this.range = 0;
    this.size = 0;
    this.setSun(35, 232); // late afternoon, from the south-west (matches the baked bridge shadows)
  }

  // elevation / azimuth in degrees; azimuth clockwise from map north
  setSun(elevation, azimuth) {
    this.elevation = elevation;
    this.azimuth = azimuth;
    const e = THREE.MathUtils.degToRad(elevation), a = THREE.MathUtils.degToRad(azimuth);
    // map (x east, y north) -> world (x, up, -y)
    this.dir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
    const day = smooth(-2, 30, elevation); // 0 at sunset, 1 by mid-morning
    const up = smooth(-4, 6, elevation);

    // Calibrated so that flat ground in full sun shows its albedo (total
    // up-facing irradiance ~ pi, roughly neutral in colour) and ground in
    // shadow keeps ~45% of that, lit by the blue sky only.
    const sunC = mixC(new THREE.Color(), [1.0, 0.45, 0.18], [1.0, 0.90, 0.76], day);
    this.sun.color.copy(sunC);
    this.sun.intensity = 3.17 * up;
    ENV.sunDir.value.copy(this.dir);
    ENV.sunColor.value.copy(sunC).multiplyScalar(2.5 * up);

    mixC(ENV.zenith.value, [0.05, 0.10, 0.26], [0.085, 0.28, 0.66], day);
    mixC(ENV.horizon.value, [0.62, 0.50, 0.42], [0.60, 0.72, 0.84], day);
    // glow added towards the sun near the horizon (sky + fog)
    ENV.haze.value.copy(sunC).multiplyScalar(lerp(0.34, 0.22, day));
    const h = Math.hypot(this.dir.x, this.dir.z) || 1;
    FOG_SUN.dir.x = this.dir.x / h; FOG_SUN.dir.y = 0; FOG_SUN.dir.z = this.dir.z / h;
    FOG_SUN.color.r = ENV.haze.value.r; FOG_SUN.color.g = ENV.haze.value.g; FOG_SUN.color.b = ENV.haze.value.b;

    this.scene.fog.color.copy(ENV.horizon.value);
    this.scene.background = this.scene.fog.color;

    // hemisphere: sky light (blue, luminance ~1) and a warm ground bounce
    mixC(this.hemi.color, [0.75, 0.8, 1.05], [0.85, 0.97, 1.15], day);
    this.hemi.groundColor.setRGB(0.66, 0.6, 0.48).multiplyScalar(lerp(0.5, 1, up));
    this.hemi.intensity = lerp(0.9, 1.45, day);

    // light-space basis of the shadow camera (it looks along -dir, up = +y)
    this.ex.crossVectors(new THREE.Vector3(0, 1, 0), this.dir).normalize();
    this.ey.crossVectors(this.dir, this.ex).normalize();
  }

  // preset: from quality.js
  setQuality(preset, renderer) {
    const on = !!preset.shadows;
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = on;
    if (!on) {
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      return;
    }
    const sh = this.sun.shadow;
    if (this.size !== preset.shadowSize && sh.map) { sh.map.dispose(); sh.map = null; }
    this.size = preset.shadowSize;
    this.range = preset.shadowRange;
    sh.mapSize.set(this.size, this.size);
    const cam = sh.camera;
    cam.left = -this.range; cam.right = this.range; cam.top = this.range; cam.bottom = -this.range;
    cam.near = 1; cam.far = 1300;
    cam.updateProjectionMatrix();
    const texel = (2 * this.range) / this.size;
    // light at 35 degrees: casters that also receive (buildings, the car)
    // need ~3 texels of normal offset against acne; the ground gets none
    // (materials.js), so shadows stay attached to wall bases
    sh.bias = -0.00004;
    sh.normalBias = texel * 3;
    sh.radius = 1;
    renderer.shadowMap.needsUpdate = true;
  }

  update(camera) {
    const R = this.range || 100; // without shadows only the direction matters
    // focus: a point on the ground ahead of the camera
    const f = camera.getWorldDirection(new THREE.Vector3());
    const fh = Math.hypot(f.x, f.z) || 1;
    const ahead = R * 0.4; // more of the map in front of the camera than behind
    const p = this.focus.set(camera.position.x + (f.x / fh) * ahead, 0, camera.position.z + (f.z / fh) * ahead).add(this.debugOffset);
    // snap to shadow-map texels in light space (u along ex, v along ey)
    const texel = (2 * R) / (this.size || 1024);
    const u = p.dot(this.ex), v = p.dot(this.ey);
    const du = Math.round(u / texel) * texel - u, dv = Math.round(v / texel) * texel - v;
    p.addScaledVector(this.ex, du).addScaledVector(this.ey, dv);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.dir, 650);
    this.sun.target.updateMatrixWorld();
  }
}

// cast + receive on solid meshes; flat ground layers (no depth write) only
// receive. Covers meshes added later by other modules (props) as well.
export function prepareShadows(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.depthWrite === false) { o.castShadow = false; o.receiveShadow = !m.transparent; }
    else { o.castShadow = true; o.receiveShadow = true; }
  });
}
