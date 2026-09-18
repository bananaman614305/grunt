import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { palette } from './palette.js';
import { NOISE_GLSL, TONE_GLSL } from './shared.js';

const warm = new Color();
const cool = new Color();
const scratch = new Color();

function createCloudLayer(opts) {
  const {
    count,
    yRange,
    spread,
    sizeRange,
    depth,
    nearZ,
    alpha,
    colorA,
    colorB,
    brightness,
    fade,
    order,
  } = opts;

  const offsets = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const drifts = new Float32Array(count);

  warm.copy(colorA);
  cool.copy(colorB);

  function place(i, z) {
    const x = (Math.random() * 2 - 1) * spread;
    const y = yRange[0] + Math.random() * (yRange[1] - yRange[0]);
    offsets[i * 3] = x;
    offsets[i * 3 + 1] = y;
    offsets[i * 3 + 2] = z;
    sizes[i] = sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]);

    // Clouds lined up with the sun catch the light; the ones off to the side
    // fall back to violet. Height adds a little more warmth on top.
    const toSun = 1 - Math.min(1, Math.abs(x) / (spread * 0.55));
    const height = (y - yRange[0]) / (yRange[1] - yRange[0]);
    const t = Math.min(1, toSun * 0.85 + height * 0.25 + Math.random() * 0.18);
    scratch.copy(cool).lerp(warm, t).multiplyScalar(brightness);
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;

    seeds[i] = Math.random();
    drifts[i] = (Math.random() - 0.5) * 3.5;
  }

  for (let i = 0; i < count; i++) {
    place(i, nearZ - Math.random() * depth);
  }

  const base = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  geometry.setAttribute('uv', base.attributes.uv);
  const aOffset = new InstancedBufferAttribute(offsets, 3);
  const aSize = new InstancedBufferAttribute(sizes, 1);
  const aColor = new InstancedBufferAttribute(colors, 3);
  const aSeed = new InstancedBufferAttribute(seeds, 1);
  geometry.setAttribute('aOffset', aOffset);
  geometry.setAttribute('aSize', aSize);
  geometry.setAttribute('aColor', aColor);
  geometry.setAttribute('aSeed', aSeed);
  geometry.instanceCount = count;

  const material = new ShaderMaterial({
    uniforms: {
      uAlpha: { value: alpha },
      uFadeNear: { value: fade[0] },
      uFadeFar: { value: fade[1] },
    },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aSeed;
      uniform float uFadeNear;
      uniform float uFadeFar;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vSeed;
      varying float vFade;
      void main() {
        vUv = uv;
        vColor = aColor;
        vSeed = aSeed;
        // Billboard in view space: the quad always faces the camera.
        vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
        // Clouds dissolve before they can engulf the camera, and thin out
        // with distance so the far bands sit back in the haze.
        float dist = -mv.z;
        vFade = smoothstep(uFadeNear, uFadeFar, dist);
        vFade *= mix(1.0, 0.55, smoothstep(2500.0, 6000.0, dist));
        mv.xy += position.xy * aSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uAlpha;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vSeed;
      varying float vFade;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float n = fbm(vUv * 3.0 + vSeed * 17.0);
        float a = smoothstep(1.0, 0.10, d + (n - 0.5) * 0.8) * uAlpha * vFade;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vColor, a);
        ${TONE_GLSL}
      }
    `,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Nothing here writes depth, so painter's order is set by hand: far bands
  // first, then the sun, then the dust.
  mesh.renderOrder = order;

  return {
    mesh,
    update(dt, speed) {
      let respawned = false;
      for (let i = 0; i < count; i++) {
        const zi = i * 3 + 2;
        offsets[zi] += speed * dt;
        offsets[i * 3] += drifts[i] * dt;
        if (offsets[zi] > nearZ) {
          place(i, offsets[zi] - depth);
          respawned = true;
        }
      }
      aOffset.needsUpdate = true;
      if (respawned) {
        aSize.needsUpdate = true;
        aColor.needsUpdate = true;
        aSeed.needsUpdate = true;
      }
    },
  };
}

export function createClouds(scene) {
  const layers = [
    // High cirrus, well above the sun, catching the last of the light.
    createCloudLayer({
      count: 45,
      yRange: [800, 1500],
      spread: 2800,
      sizeRange: [600, 1600],
      depth: 4200,
      nearZ: -1400,
      alpha: 0.32,
      colorA: palette.cloudWarm,
      colorB: palette.cloudCool,
      brightness: 0.8,
      fade: [700, 2000],
      order: 2,
    }),
    // The band of lit cloud the bird flies through.
    createCloudLayer({
      count: 120,
      yRange: [150, 500],
      spread: 1600,
      sizeRange: [260, 760],
      depth: 3600,
      nearZ: -800,
      alpha: 0.5,
      colorA: palette.cloudWarm,
      colorB: palette.cloudCool,
      brightness: 1,
      fade: [300, 1100],
      order: 3,
    }),
    // A far dark bank sitting on the water, under the sun.
    createCloudLayer({
      count: 55,
      yRange: [60, 200],
      spread: 2600,
      sizeRange: [220, 520],
      depth: 2500,
      nearZ: -3500,
      alpha: 0.65,
      colorA: palette.cloudShade,
      colorB: palette.cloudShade,
      brightness: 1,
      fade: [2500, 4000],
      order: 1,
    }),
  ];

  for (const layer of layers) scene.add(layer.mesh);

  return {
    update(dt, speed) {
      for (const layer of layers) layer.update(dt, speed);
    },
  };
}
