import * as THREE from 'three';
import { World } from './world.js';
import { Car } from './car.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';
import { PRESETS, initialQuality, nextQuality, rememberQuality, isTouchDevice } from './quality.js';
import { Lighting, prepareShadows } from './lighting.js';
import { createSky } from './sky.js';
import { setMaterialQuality } from './materials.js';
import { setTextureAnisotropy } from './textures.js';
import { buildAoMap } from './ao.js';

const STEP = 1 / 120; // physics step (s)
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const setLoading = (t) => { loadingText.textContent = t; };

async function loadMap() {
  const res = await fetch('data/bunbury.json');
  if (!res.ok) throw new Error(`map data: HTTP ${res.status}`);
  return res.json();
}

async function start() {
  const audio = new GameAudio(); // starts on the first key / touch / click
  audio.bindButton(document.getElementById('btn-mute'));
  const isTouch = isTouchDevice();
  let quality = initialQuality();
  // MSAA is fixed when the context is created: always on for high, otherwise
  // as before (off on high-DPR touch screens)
  const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high' || !isTouch || devicePixelRatio < 2, powerPreference: 'high-performance' });
  let pixelRatio = Math.min(devicePixelRatio || 1, isTouch ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.CustomToneMapping; // identity below 0.8, soft shoulder (materials.js)
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const lighting = new Lighting(scene); // sun, hemisphere light, fog
  const sky = createSky(scene);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 1, 2000);

  setLoading('Loading map data…');
  const data = await loadMap();
  setLoading('Building Bunbury…');
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now();
  const world = new World(data);
  scene.add(world.group);
  const buildMs = performance.now() - t0;

  setLoading('Shading…');
  await new Promise((r) => setTimeout(r, 20));
  const ao = buildAoMap(data, quality === 'low' ? 2048 : 4096);

  const car = new Car(world);
  scene.add(car.mesh);
  scene.add(car.shadow);
  prepareShadows(world.group);
  prepareShadows(car.mesh);
  // only the body, cabin and tyres cast: rims, spokes and lamps are hidden
  // inside or too small to matter (saves ~13 draw calls in the shadow pass)
  car.mesh.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    if (o.geometry.boundingSphere.radius < 0.35 || o.material.isMeshBasicMaterial) o.castShadow = false;
  });
  const blob = car.shadow.children[0];

  // quality: shadows, material detail, texture filtering
  const qBtn = document.getElementById('btn-quality');
  const applyQuality = (q) => {
    quality = q;
    const P = PRESETS[q];
    lighting.setQuality(P, renderer);
    setMaterialQuality(q);
    setTextureAnisotropy(renderer, q);
    // real shadows replace most of the blob; a faint one stays as contact shade
    blob.material.opacity = P.shadows ? 0.4 : 1;
    scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    qBtn.textContent = P.label;
    if (window.__game) window.__game.quality = q;
  };
  applyQuality(quality);
  const s = data.spawn;
  // keep left (Australia drives on the left)
  car.place(s.x - s.dy * 1.7, s.y + s.dx * 1.7, Math.atan2(s.dx, s.dy));

  const hudRoot = document.getElementById('hud');
  const input = new Input();
  input.attachButtons(hudRoot);
  if (isTouch) input.attachTouch(document.getElementById('touch'));
  else document.getElementById('touch').remove();
  const hud = new Hud(hudRoot, world);
  const rig = new CameraRig(camera, world);
  car.onReset = () => { rig.snap(); hud.message('Car reset'); };
  qBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const q = nextQuality(quality);
    rememberQuality(q);
    applyQuality(q);
    hud.message(`Graphics: ${q}`, 1.2);
  });
  if (!isTouch) hud.message('W A S D / arrows to drive · Space handbrake · R reset · C camera · M sound', 6);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 600);

  // stats for debugging / automated checks
  const stats = { frameMs: 0, fps: 0, calls: 0, triangles: 0, buildMs, aoMs: ao ? ao.ms : 0, worldTris: world.stats };
  const statsEl = document.getElementById('stats');
  if (DEBUG) statsEl.style.display = 'block';
  let frames = 0, acc = 0, slowTime = 0;

  let last = performance.now();
  let simAcc = 0;
  let wasInWater = false;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const inp = input.update();
    if (inp.reset) car.resetToRoad();
    if (inp.camera) { rig.next(); hud.message(`Camera: ${rig.modeName}`, 1.2); }
    simAcc += dt;
    let n = 0;
    while (simAcc >= STEP && n < 12) { car.step(STEP, inp); simAcc -= STEP; n++; }
    if (n === 12) simAcc = 0;
    car.sync(simAcc / STEP);
    if (car.surface === 'water' && !wasInWater) hud.message('Splash! Back to dry land…', 1.5);
    wasInWater = car.surface === 'water';
    rig.update(dt, car);
    sky.update(camera);
    lighting.update(camera);
    hud.update(dt, car);
    audio.update(dt, car, inp);
    renderer.info.reset(); // count the shadow pass too (autoReset clears after it)
    renderer.render(scene, camera);

    // frame timing + simple dynamic resolution for slow devices
    frames++; acc += dt;
    if (acc >= 1) {
      stats.fps = frames / acc;
      stats.frameMs = (acc / frames) * 1000;
      stats.calls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      if (stats.frameMs > 28 && pixelRatio > 1) { slowTime += acc; if (slowTime > 3) { pixelRatio = Math.max(1, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); slowTime = 0; } }
      else slowTime = 0;
      if (DEBUG) statsEl.textContent = `${stats.fps.toFixed(0)} fps · ${stats.frameMs.toFixed(1)} ms · ${stats.calls} calls · ${(stats.triangles / 1000).toFixed(0)}k tris · ${quality} · ${car.surface} · x ${car.x.toFixed(0)} y ${car.y.toFixed(0)}`;
      frames = 0; acc = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__game = { car, world, rig, input, stats, renderer, scene, camera, audio, lighting, sky, quality, setQuality: applyQuality };
}

start().catch((e) => {
  console.error(e);
  setLoading(`Could not start: ${e.message}`);
});
