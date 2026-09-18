import { Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { palette } from './palette.js';
import { NOISE_GLSL, SKY_GLSL, TONE_GLSL } from './shared.js';

const SIZE = 9000;

export function createWater(scene, shared, sunPosition) {
  const material = new ShaderMaterial({
    uniforms: {
      ...shared,
      uTime: { value: 0 },
      uScroll: { value: 0 },
      uSunPos: { value: sunPosition },
      uDeep: { value: palette.waterNear },
      uFogNear: { value: 700 },
      uFogFar: { value: 3800 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SKY_GLSL}
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uScroll;
      uniform vec3 uSunPos;
      uniform vec3 uDeep;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vWorld;

      // Four travelling swells. The gradient comes along for free, so the
      // normal is exact instead of sampled.
      void waveField(vec2 p, out float h, out vec2 g) {
        vec2 d1 = normalize(vec2(0.15, 1.0));
        vec2 d2 = normalize(vec2(-0.60, 1.0));
        vec2 d3 = normalize(vec2(0.90, 0.40));
        vec2 d4 = normalize(vec2(-0.30, 1.0));
        float ph;
        h = 0.0;
        g = vec2(0.0);

        ph = dot(d1, p) * 0.020 - uTime * 0.85;
        h += sin(ph) * 1.20; g += d1 * cos(ph) * 1.20 * 0.020;
        ph = dot(d2, p) * 0.055 - uTime * 1.60;
        h += sin(ph) * 0.44; g += d2 * cos(ph) * 0.44 * 0.055;
        ph = dot(d3, p) * 0.160 - uTime * 2.50;
        h += sin(ph) * 0.19; g += d3 * cos(ph) * 0.19 * 0.160;
        ph = dot(d4, p) * 0.420 - uTime * 3.30;
        h += sin(ph) * 0.06; g += d4 * cos(ph) * 0.06 * 0.420;
      }

      void main() {
        float h;
        vec2 grad;
        waveField(vWorld.xz, h, grad);
        vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
        vec3 V = normalize(cameraPosition - vWorld);

        float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 4.0);
        vec3 R = reflect(-V, n);
        vec3 col = mix(uDeep, skyColor(R), clamp(0.14 + fres * 1.05, 0.0, 1.0));

        // The sun's broken reflection: a glitter path running to the horizon.
        vec3 L = normalize(uSunPos - vWorld);
        float sun = max(dot(R, L), 0.0);
        float glitter = pow(sun, 300.0) * 2.8 + pow(sun, 50.0) * 0.18 + pow(sun, 6.0) * 0.05;
        float sheen = fbm(vec2(vWorld.x * 0.004, (vWorld.z - uScroll) * 0.004));
        glitter *= 0.30 + sheen * 1.4;
        col += uSunColor * glitter * smoothstep(0.0, 0.25, dot(n, L));

        // Distance: the sea gives up and becomes the sky at the horizon.
        vec3 away = normalize(vec3(vWorld.x - cameraPosition.x, 0.02, vWorld.z - cameraPosition.z));
        vec3 far = skyColor(away);
        float dist = length(vWorld.xz - cameraPosition.xz);
        col = mix(col, far, smoothstep(uFogNear, uFogFar, dist));

        gl_FragColor = vec4(col, 1.0);
        ${TONE_GLSL}
      }
    `,
  });

  const mesh = new Mesh(new PlaneGeometry(SIZE, SIZE), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -5;
  scene.add(mesh);

  return {
    mesh,
    update(elapsed, scroll) {
      material.uniforms.uTime.value = elapsed;
      material.uniforms.uScroll.value = scroll;
    },
  };
}
