import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { banner, bannerFrames, BANNER_WIDTH } from './banner.js';

const terminal = (isTTY: boolean, columns = 100) => {
  const writes: string[] = [];
  return { writes, output: { isTTY, columns, write: (text: string) => { writes.push(text); return true; } } };
};
const keyboard = (isTTY = true) => Object.assign(new EventEmitter(), { isTTY, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() });

it('animates grunt carrying token blocks in a wide terminal and restores the cursor and keyboard', async () => {
  const { writes, output } = terminal(true), input = keyboard();
  expect(await banner({ output, input: input as never, env: {}, frameMs: 0 })).toBe(true);
  const frames = writes.filter(text => text.includes('▀') || text.includes('▄'));
  expect(frames).toHaveLength(bannerFrames().length);
  expect(new Set(frames).size).toBeGreaterThan(10);
  expect(writes.at(-2)).toBe('\x1b[?25h');
  expect(writes.at(-1)).toContain('grunt');
  expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(input.listenerCount('data')).toBe(0);
});
it('stops at the next frame when any key is pressed', async () => {
  const { writes, output } = terminal(true), input = keyboard();
  const playing = banner({ output, input: input as never, env: {}, frameMs: 20 });
  input.emit('data', Buffer.from(' '));
  await playing;
  expect(writes.filter(text => text.includes('▀')).length).toBeLessThan(3);
});
it.each([
  ['stdout is not a terminal', terminal(false), {}],
  ['CI is set', terminal(true), { CI: 'true' }],
  ['the terminal is too narrow', terminal(true, BANNER_WIDTH), {}]
])('prints one static title line when %s', async (_reason, { writes, output }, env) => {
  const input = keyboard();
  expect(await banner({ output, input: input as never, env, frameMs: 0 })).toBe(false);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.trim().split('\n')).toHaveLength(1);
  expect(writes[0]).not.toContain('\x1b[?25l');
  expect(input.setRawMode).not.toHaveBeenCalled();
});
