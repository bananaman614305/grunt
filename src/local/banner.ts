import { setTimeout as delay } from 'node:timers/promises';
import chalk from 'chalk';

// An original pixel miner in the grunt.run palette: hard hat, cigar, overalls.
// Each terminal cell shows two vertical pixels with half-block characters.
const WIDTH = 48, HEIGHT = 16, PILE = 12, SPRITE = 10;
const COLORS: Record<string, string> = {
  Y: '#f4b41a', B: '#c4860c', S: '#e0a878', E: '#1a1410', C: '#6b3f22', F: '#ff5a1f', O: '#4a6fa5', D: '#3b2a1e', G: '#5a4030'
};
const TOKENS = ['#f4b41a', '#5ad1e6', '#a78bfa', '#6ee7a0', '#ff8a3d', '#f472b6'];
// Rows 1-3 hold a carried block; rows 4-14 are the miner; row 15 is the ground.
const BODY = [
  '..........', '..........', '..........', '..........',
  '...YYYY...', '...YYYY...', '..BBBBBBB.', '...SSSE...', '...SSSSCCF', '....OOO...', '..SOOOOOS.', '...OOOOO..'
];
const CARRY = [
  '...TTTT...', '...TTTT...', '...TTTT...', '..S....S..',
  '..SYYYYS..', '..SYYYYS..', '..BBBBBBB.', '...SSSE...', '...SSSSCCF', '..S.OOO.S.', '...OOOOO..', '...OOOOO..'
];
const LEGS = [['...O...O..', '..DD..DD..'], ['....O.O...', '....DDD...']];
// Pile slots, bottom row first: x and top y of a 4x3 block inside a 12-pixel pile.
const SLOTS = [[0, 12], [4, 12], [8, 12], [2, 9], [6, 9], [4, 6]] as const;

interface Scene { x: number; facing: 1 | -1; carrying: string | undefined; step: number; left: string[]; right: string[] }
function draw(scene: Scene) {
  const pixels: (string | undefined)[][] = Array.from({ length: HEIGHT }, () => Array<string | undefined>(WIDTH).fill(undefined));
  const block = (x: number, y: number, color: string) => { for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 4; dx++) pixels[y + dy]![x + dx] = color; };
  scene.left.forEach((color, slot) => block(SLOTS[slot]![0], SLOTS[slot]![1], color));
  scene.right.forEach((color, slot) => block(WIDTH - PILE + SLOTS[slot]![0], SLOTS[slot]![1], color));
  const rows = [...(scene.carrying ? CARRY : BODY), ...LEGS[scene.step % 2]!];
  rows.forEach((row, y) => [...row].forEach((code, column) => {
    if (code === '.') return;
    const x = scene.x + (scene.facing === 1 ? column : SPRITE - 1 - column);
    pixels[y + 1]![x] = code === 'T' ? scene.carrying : COLORS[code];
  }));
  pixels[HEIGHT - 1]!.fill(COLORS.G);
  const lines: string[] = [];
  for (let y = 0; y < HEIGHT; y += 2) {
    let line = '';
    for (let x = 0; x < WIDTH; x++) {
      const top = pixels[y]![x], bottom = pixels[y + 1]![x];
      if (top && bottom) line += top === bottom ? chalk.hex(top)('█') : chalk.hex(top).bgHex(bottom)('▀');
      else if (top) line += chalk.hex(top)('▀');
      else if (bottom) line += chalk.hex(bottom)('▄');
      else line += ' ';
    }
    lines.push(line);
  }
  lines.push(chalk.dim('free AI quota'.padEnd(WIDTH - 'one local agent'.length) + 'one local agent'));
  return lines;
}
// Grunt carries two token blocks from the free-quota pile to his own pile.
export function bannerFrames() {
  const start = PILE, end = WIDTH - PILE - SPRITE;
  const scene: Scene = { x: start, facing: 1, step: 0, carrying: undefined, left: TOKENS.slice(0, 6), right: [TOKENS[1]!] };
  const frames: string[][] = [];
  const shoot = (count = 1) => { for (let i = 0; i < count; i++) frames.push(draw(scene)); };
  const walk = (to: number) => {
    scene.facing = to > scene.x ? 1 : -1;
    while (scene.x !== to) { scene.x += scene.facing; scene.step++; shoot(); }
    scene.step = 0;
  };
  for (let trip = 0; trip < 2; trip++) {
    shoot(2);
    scene.carrying = scene.left.pop(); shoot(2);
    walk(end);
    scene.right.push(scene.carrying!); scene.carrying = undefined; shoot(2);
    if (trip === 0) walk(start);
  }
  shoot(3);
  return frames;
}
export const BANNER_TITLE = `${chalk.hex('#f4b41a').bold('grunt')}${chalk.dim(' — free AI inference, pooled on your machine')}`;
export const BANNER_WIDTH = WIDTH;

type Output = Pick<NodeJS.WriteStream, 'write' | 'isTTY' | 'columns'>;
type Input = Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'>;
export function shouldAnimate(output: Output, env: NodeJS.ProcessEnv = process.env) {
  return Boolean(output.isTTY) && !env.CI && env.TERM !== 'dumb' && (output.columns ?? 0) >= WIDTH + 4;
}
// Plays about three seconds of animation, or prints only the title when the
// terminal cannot show it. Any key skips; Ctrl+C still interrupts setup.
export async function banner(options: { output?: Output; input?: Input; env?: NodeJS.ProcessEnv; frameMs?: number } = {}) {
  const output = options.output ?? process.stdout, input = options.input ?? process.stdin;
  if (!shouldAnimate(output, options.env)) { output.write(BANNER_TITLE + '\n'); return false; }
  const frames = bannerFrames();
  let skipped = false, raw = false;
  const onKey = (data: Buffer) => { skipped = true; if (data.includes(3)) { restore(); process.kill(process.pid, 'SIGINT'); } };
  const restore = () => {
    input.off('data', onKey);
    if (raw) { input.setRawMode(false); input.pause(); raw = false; }
    output.write('\x1b[?25h');
  };
  if (input.isTTY) { input.setRawMode(true); raw = true; input.on('data', onKey); input.resume(); }
  output.write('\x1b[?25l');
  try {
    let shown = 0;
    for (const frame of frames) {
      output.write((shown ? `\x1b[${shown}A` : '') + frame.map(line => '\r\x1b[2K' + line).join('\n') + '\n');
      shown = frame.length;
      if (skipped) break;
      await delay(options.frameMs ?? 55);
    }
  } finally { restore(); }
  output.write(BANNER_TITLE + '\n');
  return true;
}
