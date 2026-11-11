// Daytime sky dome: zenith-to-horizon gradient, a pale haze band at the
// horizon that glows towards the sun, sun halo and disc. At and below the
// horizon it returns exactly the fog colour (plus the same sun haze term the
// fog uses), so distant tiles fade into the sky without a seam. Colours come
// from the shared ENV / FOG_SUN uniforms that lighting.js sets.

import * as THREE from 'three';
import { ENV, FOG_SUN } from './materials.js';

export function createSky(scene) {
  const geo = new THREE.SphereGeometry(1800, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: ENV.zenith,
      horizon: ENV.horizon,
      sunDir: ENV.sunDir,
      sunColor: ENV.sunColor,
      hazeDir: { value: FOG_SUN.dir },
      hazeColor: { value: FOG_SUN.color },
    },
    vertexShader: [
      'varying vec3 vDir;',
      'void main() {',
      '  vDir = position;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor;',
      'uniform vec3 hazeDir; uniform vec3 hazeColor;',
      'varying vec3 vDir;',
      '#include <common>',
      'void main() {',
      '  vec3 d = normalize( vDir );',
      '  float h = max( d.y, 0.0 );',
      '  // horizon colour = fog colour + sun haze (same expression as fog_fragment)',
      '  vec2 dh = d.xz / max( length( d.xz ), 1e-4 );',
      '  float hs = max( dot( dh, hazeDir.xz ), 0.0 );',
      '  vec3 hor = horizon + hazeColor * pow( hs, 6.0 );',
      '  // gradient: a pale band near the horizon, deepening to the zenith',
      '  vec3 col = mix( hor, zenith, pow( smoothstep( 0.0, 1.0, h ), 0.5 ) );',
      '  col = mix( col, hor, ( 1.0 - smoothstep( 0.0, 0.08, h ) ) * 0.5 );',
      '  // sun halo (fades out at the horizon, where the haze term takes over) and disc',
      '  float c = max( dot( d, sunDir ), 0.0 );',
      '  float up = smoothstep( 0.0, 0.12, h );',
      '  col += sunColor * up * ( 0.07 * pow( c, 6.0 ) + 0.12 * pow( c, 64.0 ) + 0.5 * pow( c, 900.0 ) );',
      '  col += sunColor * 6.0 * smoothstep( 0.99985, 0.99993, c );',
      '  gl_FragColor = vec4( col, 1.0 );',
      '  #include <tonemapping_fragment>',
      '  #include <colorspace_fragment>',
      '  // dither against banding in the smooth gradient',
      '  gl_FragColor.rgb += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;',
      '}',
    ].join('\n'),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    mesh,
    update(camera) { mesh.position.copy(camera.position); },
  };
}
