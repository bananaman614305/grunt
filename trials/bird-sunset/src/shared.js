import { Vector3 } from 'three';
import { palette } from './palette.js';

// The sky gradient is shared by the dome, the water reflection and the cloud
// tint, so it lives in one chunk and one uniform object.
export const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uUpper;
uniform vec3 uMid;
uniform vec3 uLow;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSunColor;
uniform vec3 uSunDir;

vec3 skyColor(vec3 dir) {
  vec3 d = normalize(dir);
  float h = d.y;

  vec3 c = uHorizon;
  c = mix(c, uLow, smoothstep(-0.005, 0.055, h));
  c = mix(c, uMid, smoothstep(0.035, 0.17, h));
  c = mix(c, uUpper, smoothstep(0.13, 0.44, h));
  c = mix(c, uZenith, smoothstep(0.36, 0.92, h));
  c = mix(uBelow, c, smoothstep(-0.30, -0.01, h));

  // haze band hugging the horizon
  c += uHorizon * exp(-abs(h) * 16.0) * 0.16;

  // scatter around the sun: wide bloom plus a tight core
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(s, 10.0) * 0.13 + pow(s, 120.0) * 0.38);

  return c;
}
`;

export function createSkyUniforms(sunDir) {
  return {
    uZenith: { value: palette.zenith },
    uUpper: { value: palette.upper },
    uMid: { value: palette.mid },
    uLow: { value: palette.low },
    uHorizon: { value: palette.horizon },
    uBelow: { value: palette.below },
    uSunColor: { value: palette.sun },
    uSunDir: { value: sunDir.clone().normalize() },
  };
}

// Vertical field of view and viewport height together decide how large a
// world-sized sprite lands on screen. Kept as a uniform so point sprites stay
// resolution independent.
export function focalLengthPixels(camera, viewportHeight) {
  return viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
}

export const TONE_GLSL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
`;

export const worldUp = new Vector3(0, 1, 0);
