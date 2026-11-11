// Shared rendering look: lit ground / object / building materials, global
// shader tweaks (sun-tinted haze in the fog, soft edge for the moving shadow
// map, a colour-preserving tone curve) and the uniforms the lighting module
// drives (sun direction / colour, sky colours, detail and AO textures).

import * as THREE from 'three';
import { detailTexture } from './textures.js';

// ------------------------------------------------------------ shared uniforms
const white1 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white1.needsUpdate = true;

export const ENV = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },    // towards the sun (world)
  sunColor: { value: new THREE.Color(1, 1, 1) },    // sun radiance for glints
  zenith: { value: new THREE.Color(0.08, 0.27, 0.66) },
  horizon: { value: new THREE.Color(0.62, 0.75, 0.86) },
  haze: { value: new THREE.Color(0.3, 0.25, 0.2) }, // added towards the sun near the horizon
  detailMap: { value: null },
  aoMap: { value: white1 },
  aoXform: { value: new THREE.Vector4(0, 0, 0, 0) }, // x0, y1 (map metres), 1/size, 1/size
  aoStrength: { value: 0.0 },
};

// Plain objects (not THREE math types) so that UniformsUtils.clone keeps the
// reference: every built-in material, including ones made elsewhere (props),
// then sees the live values without any per-material setup.
export const FOG_SUN = {
  dir: { x: 0, y: 0, z: 1 },     // horizontal direction to the sun
  color: { r: 0, g: 0, b: 0 },   // haze colour added towards the sun
};

// ------------------------------------------------------------ global chunks
let patched = false;
export function patchShaderChunks() {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk;

  // Fog: distance haze plus the low sun's glow, matching the sky's horizon.
  C.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogWorldDir;\n#endif';
  C.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogWorldDir = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;\n#endif';
  C.fog_pars_fragment = [
    '#ifdef USE_FOG',
    '\tuniform vec3 fogColor;',
    '\tuniform vec3 fogSunDir;',
    '\tuniform vec3 fogSunColor;',
    '\tvarying float vFogDepth;',
    '\tvarying vec3 vFogWorldDir;',
    '\t#ifdef FOG_EXP2',
    '\t\tuniform float fogDensity;',
    '\t#else',
    '\t\tuniform float fogNear;',
    '\t\tuniform float fogFar;',
    '\t#endif',
    '#endif',
  ].join('\n');
  C.fog_fragment = [
    '#ifdef USE_FOG',
    '\t#ifdef FOG_EXP2',
    '\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
    '\t#else',
    '\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
    '\t\tfogFactor = max( fogFactor, ( 1.0 - exp( - vFogDepth * 0.0012 ) ) * 0.3 );',
    '\t#endif',
    '\tvec2 fogH = vFogWorldDir.xz / max( length( vFogWorldDir.xz ), 1e-4 );',
    '\tfloat fogSun = max( dot( fogH, fogSunDir.xz ), 0.0 );',
    '\tvec3 fogC = fogColor + fogSunColor * ( fogSun * fogSun * fogSun * fogSun * fogSun * fogSun );',
    '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, fogFactor );',
    '#endif',
  ].join('\n');
  for (const k in THREE.ShaderLib) {
    const u = THREE.ShaderLib[k].uniforms;
    if (u && u.fogColor) { u.fogSunDir = { value: FOG_SUN.dir }; u.fogSunColor = { value: FOG_SUN.color }; }
  }

  // Shadow map follows the camera: fade shadows out towards the edge of the
  // map instead of cutting them off.
  const ret = 'return mix( 1.0, shadow, shadowIntensity );';
  const i = C.shadowmap_pars_fragment.indexOf(ret);
  if (i >= 0) {
    C.shadowmap_pars_fragment = C.shadowmap_pars_fragment.slice(0, i) +
      'vec2 sEdge = smoothstep( 0.0, 0.1, shadowCoord.xy ) * ( 1.0 - smoothstep( 0.9, 1.0, shadowCoord.xy ) );\n\t\treturn mix( 1.0, shadow, shadowIntensity * sEdge.x * sEdge.y );' +
      C.shadowmap_pars_fragment.slice(i + ret.length);
  }

  // Tone curve: identity up to 0.8 (albedo colours stay as authored), then
  // a smooth shoulder towards white for highlights (sun disc, glints, sunlit
  // walls). Hue is kept by scaling all channels, very bright values blend to
  // white. Used with renderer.toneMapping = CustomToneMapping.
  C.tonemapping_pars_fragment = C.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    [
      'vec3 CustomToneMapping( vec3 color ) {',
      '\tcolor *= toneMappingExposure;',
      '\tfloat m = max( color.r, max( color.g, color.b ) );',
      '\tif ( m <= 0.8 ) return color;',
      '\tfloat k = 0.8 + 0.2 * ( 1.0 - exp( - ( m - 0.8 ) / 0.2 ) );',
      '\tvec3 c = color * ( k / m );',
      '\treturn mix( c, vec3( k ), clamp( ( m - 1.0 ) * 0.25, 0.0, 0.85 ) );',
      '}',
    ].join('\n'));
}
patchShaderChunks();

// ------------------------------------------------------------ quality
const registry = new Set();
let detailLevel = 2;

export function setMaterialQuality(level) {
  detailLevel = level === 'low' ? 1 : level === 'medium' ? 2 : 3;
  for (const m of registry) {
    m.defines = m.defines || {};
    m.defines.DETAIL = detailLevel;
    m.needsUpdate = true;
  }
}

function register(mat, key) {
  mat.defines = Object.assign(mat.defines || {}, { DETAIL: detailLevel });
  mat.customProgramCacheKey = () => key + detailLevel;
  registry.add(mat);
  if (!ENV.detailMap.value) ENV.detailMap.value = detailTexture();
}

// ------------------------------------------------------------ ground
// Flat ground layers (no normals: the normal is forced up). Lit, receives
// shadows, keeps depthWrite:false so the layers still stack by draw order.
// Surface detail is chosen from the colour itself (asphalt, grass, sand,
// paving), so no extra vertex data is needed. Water (strongly blue colour)
// gets ripples, a sky reflection with fresnel and a sun glint.
const GROUND_VERT_COMMON = '#include <common>\nvarying vec2 vWP;';
const GROUND_FRAG_COMMON = [
  '#include <common>',
  'varying vec2 vWP;',
  'uniform float uTime;',
  'uniform sampler2D detailMap;',
  'uniform sampler2D aoMap2;',
  'uniform vec4 aoXform;',
  'uniform float aoStrength;',
  'uniform vec3 envSunDir;',
  'uniform vec3 envSunColor;',
  'uniform vec3 envZenith;',
  'uniform vec3 envHorizon;',
].join('\n');

const GROUND_SURFACE = [
  'float waterMask = 0.0;',
  'float groundAO = 1.0;',
  '{',
  '  vec3 c = diffuseColor.rgb;',
  '  vec2 p = vWP;',
  '  if ( c.b > c.g * 1.4 && c.b > c.r * 4.0 ) {',
  '    waterMask = 1.0;',
  '    float t = uTime;',
  '    float big = 0.6 * sin( p.x * 0.0061 + 1.3 ) * sin( p.y * 0.0047 - 0.4 ) + 0.25 * sin( p.x * 0.0137 - p.y * 0.0081 + t * 0.05 ) + 0.2 * sin( p.x * 0.0029 + p.y * 0.0113 - t * 0.03 );',
  '    diffuseColor.rgb *= 1.0 + 0.06 * big;',
  '  } else {',
  '    float mx = max( c.r, max( c.g, c.b ) ), mn = min( c.r, min( c.g, c.b ) );',
  '    float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );',
  '    float sat = ( mx - mn ) / ( mx + 1e-4 );',
  '    float wG = smoothstep( 0.02, 0.10, c.g - max( c.r, c.b ) );',
  '    float wS = ( 1.0 - wG ) * smoothstep( 0.25, 0.45, sat ) * step( c.b, c.g );',
  '    float rest = max( 0.0, 1.0 - wG - wS );',
  '    float wA = rest * ( 1.0 - smoothstep( 0.10, 0.22, lum ) );',
  '    vec4 w = vec4( wA, wG, wS, rest - wA );',
  '    float paint = smoothstep( 0.6, 0.8, lum );',
  '    float d = dot( texture2D( detailMap, p / 6.0 ) - 0.5, w * vec4( 0.6, 0.55, 0.35, 0.35 ) );',
  '    #if DETAIL >= 2',
  '      d += dot( texture2D( detailMap, mat2( 0.8, -0.6, 0.6, 0.8 ) * p / 47.0 ).gbar - 0.5, w * vec4( 0.25, 0.35, 0.2, 0.2 ) );',
  '    #endif',
  '    #if DETAIL >= 3',
  '      d += dot( texture2D( detailMap, mat2( 0.6, 0.8, -0.8, 0.6 ) * p / 2.3 + 0.31 ) - 0.5, w * vec4( 0.3, 0.3, 0.2, 0.2 ) );',
  '    #endif',
  '    diffuseColor.rgb *= 1.0 + d * ( 1.0 - 0.75 * paint );',
  '    vec2 aoUv = vec2( ( p.x - aoXform.x ) * aoXform.z, ( aoXform.y + p.y ) * aoXform.w );',
  '    groundAO = mix( 1.0, texture2D( aoMap2, aoUv ).r, aoStrength );',
  '  }',
  '}',
].join('\n');

const GROUND_WATER = [
  'if ( waterMask > 0.5 ) {',
  '  vec3 wp = vec3( vWP.x, 0.0, vWP.y );',
  '  vec3 toCam = cameraPosition - wp;',
  '  float dist = length( toCam );',
  '  vec3 V = toCam / dist;',
  '  float near = 1.0 - smoothstep( 30.0, 260.0, dist );',
  '  vec2 p = vWP; float t = uTime;',
  '  // slopes of a few travelling waves; small ones fade with distance (no aliasing)',
  '  vec2 sl = 0.05 * vec2( cos( p.x * 0.21 + sin( p.y * 0.13 ) * 1.7 + t * 1.1 ), cos( p.y * 0.17 - sin( p.x * 0.11 ) * 1.5 - t * 0.8 ) ) * near;',
  '  sl += 0.035 * vec2( sin( p.x * 0.53 - p.y * 0.31 + t * 1.9 ), sin( p.y * 0.47 + p.x * 0.29 - t * 1.6 ) ) * near * near;',
  '  sl += 0.012 * vec2( sin( p.x * 0.031 + p.y * 0.017 + t * 0.4 ), cos( p.y * 0.027 - p.x * 0.013 + t * 0.35 ) );',
  '  vec3 N = normalize( vec3( - sl.x, 1.0, - sl.y ) );',
  '  float ndv = clamp( dot( N, V ), 0.0, 1.0 );',
  '  float fres = 0.02 + 0.98 * pow( 1.0 - ndv, 5.0 );',
  '  vec3 R = reflect( - V, N );',
  '  // sky seen in the water: horizon haze to zenith blue, a little darker than',
  '  // the sky itself so the sea still reads as water at grazing angles',
  '  vec3 skyR = mix( envHorizon * 0.8, envZenith, sqrt( clamp( R.y, 0.0, 1.0 ) ) );',
  '  outgoingLight = mix( outgoingLight, skyR, clamp( fres, 0.0, 0.6 ) );',
  '  float sd = max( dot( R, envSunDir ), 0.0 );',
  '  outgoingLight += envSunColor * ( pow( sd, 400.0 ) * 4.0 + pow( sd, 24.0 ) * 0.06 ) * ( 0.3 + 0.7 * near );',
  '}',
].join('\n');

export function makeGroundMaterial(opts = {}) {
  const params = { depthWrite: false, side: THREE.DoubleSide };
  if (opts.color) params.color = opts.color; else params.vertexColors = true;
  const mat = new THREE.MeshLambertMaterial(params);
  const uTime = { value: 0 };
  mat.userData.uTime = uTime;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.detailMap = ENV.detailMap;
    sh.uniforms.aoMap2 = ENV.aoMap;
    sh.uniforms.aoXform = ENV.aoXform;
    sh.uniforms.aoStrength = ENV.aoStrength;
    sh.uniforms.envSunDir = ENV.sunDir;
    sh.uniforms.envSunColor = ENV.sunColor;
    sh.uniforms.envZenith = ENV.zenith;
    sh.uniforms.envHorizon = ENV.horizon;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', GROUND_VERT_COMMON)
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\ntransformedNormal = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = ( modelMatrix * vec4( position, 1.0 ) ).xz;')
      // the ground never casts, so it cannot self-shadow: no normal offset
      // (keeps shadows attached to wall bases, no peter-panning)
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex.replace(
        'vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );', 'vec3 shadowWorldNormal = vec3( 0.0 );'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', GROUND_FRAG_COMMON)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_SURFACE)
      // the flat layers are wound clockwise in world space (map y is flipped),
      // so ignore the double-sided face flip: the ground always faces up
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );\nnonPerturbedNormal = normal;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= groundAO;\nreflectedLight.directDiffuse *= mix( 1.0, groundAO, 0.5 );')
      .replace('#include <opaque_fragment>', GROUND_WATER + '\n#include <opaque_fragment>');
  };
  register(mat, opts.color ? 'ground-c' : 'ground-v');
  return mat;
}

// ------------------------------------------------------------ 3D objects
// Trees, parapets, posts, lighthouse: lit vertex colours, double-sided shadow
// casting so thin single-sided pieces still cast.
export function makeObjectMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.shadowSide = THREE.DoubleSide;
  return mat;
}

// ------------------------------------------------------------ buildings
// Adds to the facade-atlas building material (keeps its UVs): darker wall
// feet (contact shading), darker undersides (eaves, awnings), and soft
// world-space weathering on walls and roofs from the detail texture.
export function enhanceBuildingMaterial(mat) {
  mat.shadowSide = THREE.DoubleSide;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.detailMap = ENV.detailMap;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBW;\nvarying vec3 vBN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;\nvBN = ( modelMatrix * vec4( normal, 0.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBW;\nvarying vec3 vBN;\nuniform sampler2D detailMap;')
      .replace('#include <alphamap_fragment>', [
        '{',
        '  vec3 n = normalize( vBN );',
        '  float wall = 1.0 - smoothstep( 0.35, 0.6, abs( n.y ) );',
        '  float foot = mix( 0.66, 1.0, smoothstep( 0.0, 2.4, vBW.y ) );',
        '  vec2 wuv = n.y > 0.5 ? vBW.xz : vec2( abs( n.x ) > abs( n.z ) ? vBW.z : vBW.x, vBW.y );',
        '  float k = 1.0 + ( texture2D( detailMap, wuv / 19.0 ).a - 0.5 ) * 0.25;',
        '  #if DETAIL >= 2',
        '    k *= 1.0 + ( texture2D( detailMap, wuv / 3.7 ).r - 0.5 ) * 0.2 * step( 0.5, n.y );',
        '  #endif',
        '  diffuseColor.rgb *= mix( 1.0, foot, wall ) * k * ( n.y < -0.5 ? 0.82 : 1.0 );',
        '}',
        '#include <alphamap_fragment>',
      ].join('\n'));
  };
  register(mat, 'bld-' + prevKey() + '-');
  return mat;
}
