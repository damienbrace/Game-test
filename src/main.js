import * as THREE from 'three';
import { World } from './world.js';
import { Car } from './car.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';

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

function makeSky(scene, horizon) {
  const geo = new THREE.SphereGeometry(1800, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color(0x4f8fd6) }, horizon: { value: horizon } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform vec3 top; uniform vec3 horizon; varying vec3 vP;',
      'void main() {',
      '  float h = clamp(normalize(vP).y, 0.0, 1.0);',
      '  gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -20;
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

async function start() {
  const audio = new GameAudio(); // starts on the first key / touch / click
  audio.bindButton(document.getElementById('btn-mute'));
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: !isTouch || devicePixelRatio < 2, powerPreference: 'high-performance' });
  let pixelRatio = Math.min(devicePixelRatio || 1, isTouch ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0xcfe1ee);
  scene.background = horizon;
  scene.fog = new THREE.Fog(horizon, 260, 1050);
  const sky = makeSky(scene, horizon);
  scene.add(new THREE.HemisphereLight(0xdcecff, 0x8a8068, 1.5));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  sun.position.set(-0.45, 1, 0.35).normalize(); // afternoon sun from the north-west
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 1, 2000);

  setLoading('Loading map data…');
  const data = await loadMap();
  setLoading('Building Bunbury…');
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now();
  const world = new World(data);
  scene.add(world.group);
  const buildMs = performance.now() - t0;

  const car = new Car(world);
  scene.add(car.mesh);
  scene.add(car.shadow);
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
  if (!isTouch) hud.message('W A S D / arrows to drive · Space handbrake · R reset · C camera · M sound', 6);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 600);

  // stats for debugging / automated checks
  const stats = { frameMs: 0, fps: 0, calls: 0, triangles: 0, buildMs, worldTris: world.stats };
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
    sky.position.copy(camera.position);
    hud.update(dt, car);
    audio.update(dt, car, inp);
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
      if (DEBUG) statsEl.textContent = `${stats.fps.toFixed(0)} fps · ${stats.frameMs.toFixed(1)} ms · ${stats.calls} calls · ${(stats.triangles / 1000).toFixed(0)}k tris · ${car.surface} · x ${car.x.toFixed(0)} y ${car.y.toFixed(0)}`;
      frames = 0; acc = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__game = { car, world, rig, input, stats, renderer, scene, camera, audio };
}

start().catch((e) => {
  console.error(e);
  setLoading(`Could not start: ${e.message}`);
});
