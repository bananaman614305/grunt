import { AdditiveBlending, CircleGeometry, Group, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { palette } from './palette.js';
import { TONE_GLSL } from './shared.js';

const RADIAL_UV = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function createDisc(radius) {
  return new Mesh(
    new CircleGeometry(radius, 96),
    new ShaderMaterial({
      uniforms: {
        uCore: { value: palette.sunCore },
        uEdge: { value: palette.sun },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: RADIAL_UV,
      fragmentShader: /* glsl */ `
        uniform vec3 uCore;
        uniform vec3 uEdge;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float body = 1.0 - smoothstep(0.94, 1.0, r);
          vec3 c = mix(uEdge, uCore, pow(1.0 - clamp(r, 0.0, 1.0), 0.6));
          gl_FragColor = vec4(c * body * 2.4, 1.0);
          ${TONE_GLSL}
        }
      `,
    })
  );
}

function createGlow(size) {
  return new Mesh(
    new PlaneGeometry(size, size),
    new ShaderMaterial({
      uniforms: {
        uSunColor: { value: palette.sun },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: RADIAL_UV,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunColor;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float core = exp(-r * 7.0);
          float halo = pow(max(0.0, 1.0 - r), 3.0);
          float streak = exp(-abs(p.y) * 9.0) * exp(-abs(p.x) * 2.4);
          float rays = 0.5 + 0.5 * sin(atan(p.y, p.x) * 14.0 + uTime * 0.05);
          float a = core * 0.95 + halo * 0.22 + streak * 0.30;
          a *= 1.0 + rays * 0.22 * exp(-r * 2.2);
          gl_FragColor = vec4(uSunColor * a * 0.55, 1.0);
          ${TONE_GLSL}
        }
      `,
    })
  );
}

export function createSun(scene, sunPosition, radius = 70) {
  const group = new Group();
  group.position.copy(sunPosition);

  const glow = createGlow(radius * 3);
  glow.renderOrder = 4;
  const disc = createDisc(radius);
  disc.renderOrder = 4;
  group.add(glow, disc);
  scene.add(group);

  return {
    group,
    update(camera, elapsed) {
      glow.material.uniforms.uTime.value = elapsed;
      // Billboard both planes; the water in front clips the part below the
      // horizon, so the sun sits on the sea instead of floating over it.
      glow.quaternion.copy(camera.quaternion);
      disc.quaternion.copy(camera.quaternion);
    },
  };
}
