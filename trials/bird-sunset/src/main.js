import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { createBird } from './bird.js';
import { createAudio, createBreath } from './ambience.js';
import { createClouds } from './clouds.js';
import { createMotes } from './motes.js';
import { createSky } from './sky.js';
import { createSun } from './sun.js';
import { createSkyUniforms, focalLengthPixels } from './shared.js';
import { createWater } from './water.js';

const SUN_POSITION = new Vector3(0, 255, -1500);
const SUN_RADIUS = 150;
const FLIGHT_SPEED = 34;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const speed = FLIGHT_SPEED * (reducedMotion ? 0.35 : 1);
const sway = reducedMotion ? 0.2 : 1;

const canvas = document.getElementById('scene');
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMappingExposure = 1.05;

const scene = new Scene();
const camera = new PerspectiveCamera(52, 1, 1, 12000);
camera.position.set(0, 44, 60);

const shared = createSkyUniforms(SUN_POSITION);
const sky = createSky(scene, shared);
const sun = createSun(scene, SUN_POSITION, SUN_RADIUS);
const water = createWater(scene, shared, SUN_POSITION);
const clouds = createClouds(scene);
const motes = createMotes(scene);

const hero = createBird(shared, { scale: 2.2, flapSpeed: 0.5, phase: 0, glideAmount: 0.5 });
hero.group.position.set(8, 59, -60);
scene.add(hero.group);

const flock = [
  { position: [-150, 78, -350], scale: 1.0, flapSpeed: 0.46 },
  { position: [110, 104, -520], scale: 0.75, flapSpeed: 0.55 },
  { position: [-70, 48, -260], scale: 0.55, flapSpeed: 0.62 },
  { position: [200, 142, -780], scale: 1.1, flapSpeed: 0.42 },
].map(({ position, scale: s, flapSpeed }, i) => {
  const bird = createBird(shared, {
    scale: s,
    flapSpeed,
    phase: i * 1.7,
    glideAmount: 0.45,
  });
  bird.group.position.fromArray(position);
  scene.add(bird.group);
  return bird;
});

const breath = createBreath(document.getElementById('breath-ring'), document.getElementById('breath-label'));
const audio = createAudio();

const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
let paused = false;
let scroll = 0;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  sky.setPixelRatio(renderer.getPixelRatio());
  motes.setFocal(focalLengthPixels(camera, renderer.domElement.height));
}

const lookTarget = new Vector3();
let last = performance.now();
let elapsed = 0;
let firstFrame = true;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const step = paused ? 0 : dt;
  elapsed += step;
  scroll += speed * step;

  pointer.x += (pointer.targetX - pointer.x) * Math.min(1, dt * 2);
  pointer.y += (pointer.targetY - pointer.y) * Math.min(1, dt * 2);

  camera.position.set(
    Math.sin(elapsed * 0.19) * 4 * sway + pointer.x * 4,
    44 + Math.sin(elapsed * 0.33) * 1.6 * sway + pointer.y * 3,
    60 + Math.sin(elapsed * 0.11) * 3 * sway
  );
  lookTarget.set(
    SUN_POSITION.x + Math.sin(elapsed * 0.13) * 10 * sway,
    SUN_POSITION.y + Math.sin(elapsed * 0.23) * 6 * sway,
    SUN_POSITION.z
  );
  camera.lookAt(lookTarget);

  sky.update(camera, elapsed);
  sun.update(camera, elapsed);
  water.update(elapsed, scroll);
  clouds.update(step, speed);
  motes.update(step, speed, elapsed);
  hero.update(elapsed);
  for (const bird of flock) bird.update(elapsed);
  breath.update(step);

  renderer.render(scene, camera);

  if (firstFrame) {
    firstFrame = false;
    document.body.classList.add('ready');
  }
}

const overlay = document.getElementById('overlay');
let hideTimer = 0;

function nudgeOverlay() {
  overlay.classList.remove('faded');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => overlay.classList.add('faded'), 7000);
}

function setSoundLabel() {
  document.getElementById('sound-state').textContent = audio.enabled ? 'on' : 'off';
}

window.addEventListener('resize', resize);
window.addEventListener('pointermove', (event) => {
  pointer.targetX = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.targetY = -((event.clientY / window.innerHeight) * 2 - 1);
  nudgeOverlay();
});

window.addEventListener('keydown', async (event) => {
  const key = event.key.toLowerCase();
  if (key === 'm') {
    await audio.toggle();
    setSoundLabel();
  } else if (key === 'h') {
    overlay.classList.toggle('hidden');
  } else if (key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  } else if (event.code === 'Space') {
    event.preventDefault();
    paused = !paused;
  }
  nudgeOverlay();
});

resize();
nudgeOverlay();
renderer.setAnimationLoop(frame);
