import {
  BufferGeometry,
  ConeGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { palette } from './palette.js';
import { TONE_GLSL } from './shared.js';

// A dark bird in front of the sun is mostly silhouette; all the modelling that
// survives is the outline and the lit rim along the wings.
const RIM_VERTEX = /* glsl */ `
  varying vec3 vN;
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vN = normalize(mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const RIM_FRAGMENT = /* glsl */ `
  uniform vec3 uBody;
  uniform vec3 uRim;
  uniform vec3 uBounce;
  uniform vec3 uSunDir;
  varying vec3 vN;
  varying vec3 vWorld;
  void main() {
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorld);
    float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6);
    float lit = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBody, uRim, clamp(rim * lit * 1.35, 0.0, 1.0));
    col += uBounce * (0.5 - 0.5 * N.y) * 0.55;
    gl_FragColor = vec4(col, 1.0);
    ${TONE_GLSL}
  }
`;

function createMaterial(shared) {
  return new ShaderMaterial({
    uniforms: {
      ...shared,
      uBody: { value: palette.birdBody },
      uRim: { value: palette.birdRim },
      uBounce: { value: palette.birdBounce },
    },
    vertexShader: RIM_VERTEX,
    fragmentShader: RIM_FRAGMENT,
    side: DoubleSide,
  });
}

// One wing panel: a tapered, swept quad from root to tip, flat and double
// sided so it reads as pure silhouette.
function wingPanel(side, rootFront, rootBack, tipFront, tipBack, span) {
  const x0 = 0;
  const x1 = span * side;
  const positions = [
    x0, 0, rootFront,
    x0, 0, rootBack,
    x1, 0, tipBack,
    x0, 0, rootFront,
    x1, 0, tipBack,
    x1, 0, tipFront,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildWing(side, material) {
  const root = new Group();
  root.position.set(side * 0.30, 0.10, -0.05);

  const inner = new Mesh(wingPanel(side, -0.55, 0.85, -0.30, 0.62, 1.5), material);
  root.add(inner);

  const elbow = new Group();
  elbow.position.set(side * 1.5, 0, 0);
  elbow.add(new Mesh(wingPanel(side, -0.30, 0.62, 0.55, 0.78, 1.45), material));
  root.add(elbow);

  return { root, elbow };
}

function buildTail(material) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 1.0, -0.5, 0, 1.75, 0.5, 0, 1.75], 3)
  );
  geometry.computeVertexNormals();
  return new Mesh(geometry, material);
}

export function createBird(shared, options = {}) {
  const {
    scale = 1,
    flapSpeed = 0.52,
    phase = Math.random() * Math.PI * 2,
    glideAmount = 0.55,
  } = options;

  const material = createMaterial(shared);
  const group = new Group();
  group.scale.setScalar(scale);

  const body = new Mesh(new SphereGeometry(1, 16, 12), material);
  body.scale.set(0.40, 0.34, 1.30);

  const head = new Mesh(new SphereGeometry(1, 12, 10), material);
  head.scale.set(0.25, 0.24, 0.27);
  head.position.set(0, 0.10, -1.16);

  const beak = new Mesh(new ConeGeometry(0.075, 0.34, 8), material);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 0.05, -1.48);

  const tail = buildTail(material);

  const right = buildWing(1, material);
  const left = buildWing(-1, material);

  group.add(body, head, beak, tail, right.root, left.root);

  const flapRate = flapSpeed * Math.PI * 2;
  let base = null;

  return {
    group,
    material,
    update(t) {
      if (!base) base = group.position.clone();
      // Drift around the spot it was placed, scaled so a big bird drifts wide.
      group.position.set(
        base.x + Math.sin(t * 0.24 + phase) * 1.8 * scale,
        base.y + Math.sin(t * 0.37 + phase) * 1.3 * scale,
        base.z + Math.sin(t * 0.19 + phase) * 1.2 * scale
      );

      // Slow alternation between flapping and a long glide.
      const glide = 0.5 + 0.5 * Math.sin(t * 0.085 + phase);
      const amp = glideAmount + (1 - glideAmount) * glide;
      const flap = Math.sin(t * flapRate + phase) * amp;
      const flapOuter = Math.sin(t * flapRate + phase - 0.6) * amp;

      right.root.rotation.z = 0.10 + flap * 0.62;
      left.root.rotation.z = -(0.10 + flap * 0.62);
      right.root.rotation.y = -0.05 + flap * 0.06;
      left.root.rotation.y = 0.05 - flap * 0.06;
      right.elbow.rotation.z = flapOuter * 0.44 + 0.05;
      left.elbow.rotation.z = -(flapOuter * 0.44 + 0.05);
      right.elbow.rotation.x = flapOuter * 0.10;
      left.elbow.rotation.x = flapOuter * 0.10;

      group.rotation.z = -Math.sin(t * 0.31 + phase) * 0.10;
      group.rotation.x = Math.sin(t * 0.42 + phase) * 0.05;
      group.rotation.y = Math.sin(t * 0.17 + phase) * 0.06;
    },
  };
}
