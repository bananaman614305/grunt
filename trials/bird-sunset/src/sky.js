import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { SKY_GLSL, TONE_GLSL } from './shared.js';

const DOME_RADIUS = 6000;

function createDome(shared) {
  const material = new ShaderMaterial({
    uniforms: shared,
    side: BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${SKY_GLSL}
      varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(skyColor(vDir), 1.0);
        ${TONE_GLSL}
      }
    `,
  });

  const dome = new Mesh(new SphereGeometry(DOME_RADIUS, 48, 32), material);
  dome.renderOrder = -10;
  return dome;
}

function createStars(sunDir) {
  const count = 1200;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Upper hemisphere only, biased away from the horizon.
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const y = Math.pow(Math.abs(u), 0.7);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    positions[i * 3] = Math.cos(phi) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(phi) * r;
    sizes[i] = 1.1 + Math.pow(Math.random(), 3) * 3.4;
    seeds[i] = Math.random();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSunDir: { value: sunDir },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec3 uSunDir;
      varying float vAlpha;
      void main() {
        vec3 dir = normalize(position);
        float twinkle = 0.55 + 0.45 * sin(uTime * (0.4 + aSeed * 0.9) + aSeed * 31.0);
        float height = smoothstep(0.06, 0.42, dir.y);
        float awayFromSun = 1.0 - smoothstep(0.45, 0.99, dot(dir, uSunDir));
        vAlpha = height * awayFromSun * twinkle;
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.05, d) * vAlpha;
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.9) * a, 1.0);
        ${TONE_GLSL}
      }
    `,
  });

  const points = new Points(geometry, material);
  points.scale.setScalar(DOME_RADIUS * 0.92);
  points.renderOrder = -9;
  return points;
}

export function createSky(scene, shared) {
  const group = new Group();
  const dome = createDome(shared);
  const stars = createStars(shared.uSunDir.value);
  group.add(dome, stars);
  scene.add(group);

  return {
    group,
    setPixelRatio(value) {
      stars.material.uniforms.uPixelRatio.value = value;
    },
    update(camera, elapsed) {
      // The dome rides with the camera so the sunset stays infinitely far away.
      group.position.copy(camera.position);
      stars.material.uniforms.uTime.value = elapsed;
    },
  };
}
