import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
} from 'three';
import { palette } from './palette.js';
import { TONE_GLSL } from './shared.js';

const COUNT = 520;
const NEAR_Z = 30;
const DEPTH = 1100;

export function createMotes(scene) {
  const positions = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const seeds = new Float32Array(COUNT);

  function place(i, z) {
    positions[i * 3] = (Math.random() * 2 - 1) * 320;
    positions[i * 3 + 1] = 4 + Math.random() * 190;
    positions[i * 3 + 2] = z;
    sizes[i] = 0.22 + Math.random() * 0.7;
    seeds[i] = Math.random();
  }

  for (let i = 0; i < COUNT; i++) place(i, NEAR_Z - Math.random() * DEPTH);

  const geometry = new BufferGeometry();
  const positionAttr = new BufferAttribute(positions, 3);
  const sizeAttr = new BufferAttribute(sizes, 1);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

  const material = new ShaderMaterial({
    uniforms: {
      uFocal: { value: 900 },
      uTime: { value: 0 },
      uColor: { value: palette.sun },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aSeed;
      uniform float uFocal;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        // Fade in from the far edge, fade out as they slip past the camera.
        vAlpha = smoothstep(60.0, 260.0, dist) * (1.0 - smoothstep(700.0, 1050.0, dist));
        vAlpha *= 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.5 + aSeed) + aSeed * 24.0));
        gl_PointSize = clamp(aSize * uFocal / dist, 1.0, 14.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        gl_FragColor = vec4(uColor * a, 1.0);
        ${TONE_GLSL}
      }
    `,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  return {
    points,
    setFocal(value) {
      material.uniforms.uFocal.value = value;
    },
    update(dt, speed, elapsed) {
      material.uniforms.uTime.value = elapsed;
      for (let i = 0; i < COUNT; i++) {
        const zi = i * 3 + 2;
        positions[zi] += speed * dt * (0.85 + seeds[i] * 0.5);
        positions[i * 3] += Math.sin(elapsed * 0.3 + seeds[i] * 12.0) * dt * 2.0;
        positions[i * 3 + 1] += Math.sin(elapsed * 0.22 + seeds[i] * 7.0) * dt * 1.4;
        if (positions[zi] > NEAR_Z) place(i, positions[zi] - DEPTH);
      }
      positionAttr.needsUpdate = true;
    },
  };
}
