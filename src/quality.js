// Rendering quality presets: low / medium / high.
//
// Chosen automatically (phones / small or low-DPR touch screens -> low or
// medium, desktop -> high), overridable with ?quality=low|medium|high and the
// QUALITY HUD button (the button's choice is remembered in localStorage).

export const LEVELS = ['low', 'medium', 'high'];

export const PRESETS = {
  // no shadow map: the car keeps its blob shadow; one detail texture fetch
  low: { shadows: false, shadowSize: 0, shadowRange: 0, detail: 1, label: 'LOW' },
  // one 2048 shadow map around the camera focus
  medium: { shadows: true, shadowSize: 2048, shadowRange: 150, softShadows: false, detail: 2, label: 'MED' },
  // 4096 soft shadow map covering more ground, all detail layers
  high: { shadows: true, shadowSize: 4096, shadowRange: 230, softShadows: true, detail: 3, label: 'HIGH' },
};

const KEY = 'cc-quality';

export function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
}

export function autoQuality() {
  if (!isTouchDevice()) return 'high';
  const small = Math.min(screen.width, screen.height) < 420;
  const lowMem = navigator.deviceMemory !== undefined && navigator.deviceMemory <= 3;
  const lowDpr = (devicePixelRatio || 1) < 1.5;
  return small || lowMem || lowDpr ? 'low' : 'medium';
}

export function initialQuality() {
  const q = new URLSearchParams(location.search).get('quality');
  if (LEVELS.includes(q)) return q;
  try {
    const s = localStorage.getItem(KEY);
    if (LEVELS.includes(s)) return s;
  } catch (e) { /* storage blocked */ }
  return autoQuality();
}

export function rememberQuality(q) {
  try { localStorage.setItem(KEY, q); } catch (e) { /* storage blocked */ }
}

export function nextQuality(q) { return LEVELS[(LEVELS.indexOf(q) + 1) % LEVELS.length]; }
