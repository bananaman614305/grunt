import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import type { setupFallbacks } from './fallback-setup.js';
import { SetupTable } from './setup-table.js';
import { withTerminal } from './terminal.js';
import { wizard } from './wizard.js';

vi.mock('@clack/prompts', () => Object.fromEntries(['text', 'password', 'confirm', 'select', 'multiselect'].map(name => [name, vi.fn(() => { throw new Error(`Unexpected prompt: ${name}`); })])));
let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

// A small terminal model: auto-wrap at the last column, cursor up, erase line,
// erase below. That is all the table writes.
class Screen {
  lines: string[][] = [[]];
  row = 0;
  col = 0;
  isTTY = true as const;
  constructor(public columns: number) {}
  private cell() { while (this.lines.length <= this.row) this.lines.push([]); return this.lines[this.row]!; }
  write(data: string) {
    const pattern = /\x1b\[(\d*)([AJK])|\r|\n|[^\x1b\r\n]/gu;
    for (const [token, count, command] of data.matchAll(pattern)) {
      if (command === 'A') { this.row = Math.max(0, this.row - Number(count || 1)); }
      else if (command === 'K') this.cell().splice(0);
      else if (command === 'J') { this.cell().splice(this.col); this.lines.splice(this.row + 1); }
      else if (token === '\r') this.col = 0;
      else if (token === '\n') { this.row++; this.col = 0; this.cell(); }
      else {
        if (this.col >= this.columns) { this.row++; this.col = 0; }
        const line = this.cell();
        while (line.length < this.col) line.push(' ');
        line[this.col++] = token;
      }
    }
    return true;
  }
  // The model never drops lines, so this is scrollback plus the screen.
  text() { return this.lines.map(line => line.join('').trimEnd()).filter(Boolean); }
}

const rows: [kind: 'tool' | 'source', name: string, status: string][] = [
  ['tool', 'claude-code', 'connecting'], ['source', 'kilo', 'connecting'], ['source', 'pollinations', 'connecting'],
  ['source', 'mistral-vibe', 'connecting'], ['source', 'nous', 'connecting'], ['source', 'kilo', '✓ ready'],
  ['source', 'pollinations', 'skipped (browser could not continue)'], ['tool', 'claude-code', '✓ connected'],
  ['source', 'mistral-vibe', 'skipped (browser could not continue)'], ['source', 'nous', 'needs you (Nous login)']
];

it.each([40, 50, 60, 80])('keeps each row on one line with no stale characters at %i columns', columns => {
  const screen = new Screen(columns);
  const table = new SetupTable(screen);
  const frames: string[] = [];
  const write = screen.write.bind(screen);
  screen.write = (data: string) => { frames.push(data); return write(data); };
  for (const [kind, name, status] of rows) table.set(kind, name, status);
  for (const frame of frames) {
    for (const line of frame.replace(/\x1b\[\d*[AJK]|\r/g, '').split('\n')) expect([...line].length).toBeLessThan(columns);
  }
  const text = screen.text();
  expect(text).toHaveLength(6);
  expect(text[0]).toMatch(/^(type\s+)?name\s+status$/);
  const final = { 'claude-code': '✓ connected', kilo: '✓ ready', pollinations: 'skipped (browser', 'mistral-vibe': 'skipped (browser', nous: 'needs you (Nous login)' };
  for (const [index, [name, status]] of Object.entries(final).entries()) {
    expect(text[index + 1]).toMatch(new RegExp(`^(tool|source)?\\s*${name}\\s+${status.replace(/[()]/g, '\\$&')}`));
  }
});

it('keeps one table in place through a full setup run with interleaved output', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-setup-table-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
  const screen = new Screen(50);
  const write = (chunk: unknown) => screen.write(String(chunk));
  for (const [name, value] of [['isTTY', true], ['columns', 50]] as const) {
    const previous = Object.getOwnPropertyDescriptor(process.stdout, name);
    Object.defineProperty(process.stdout, name, { configurable: true, value });
    onTestFinished(() => { if (previous) Object.defineProperty(process.stdout, name, previous); else Reflect.deleteProperty(process.stdout, name); });
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
  // Vitest captures console itself; route it through stdout like Node does.
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { process.stdout.write(`${String(line)}\n`); });
  const ids = ['kilo', 'pollinations', 'zro', 'nous'];
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'close').mockImplementation(async () => {});
  const signups = vi.fn(async (options: Parameters<typeof setupFallbacks>[0]) => {
    for (const id of options.adapters) {
      // Output from Squire, debug lines and child processes during signups.
      console.log(`squire chatter for ${id}`);
      process.stderr.write(`grunt setup: ${id}: debug\n`);
      if (id === 'zro') await withTerminal(async () => {
        console.log('Verify zro in your browser: https://h.test/zro');
        // A row changes while the prompt is still open.
        await options.onSettled?.('zro', true);
        console.log('Finished verifying zro? yes');
      });
      await options.onSettled?.(id, id !== 'nous', id === 'nous' ? 'needs Nous login' : undefined);
    }
    return { unavailable: options.adapters.filter(id => id === 'nous') };
  });
  await wizard(undefined, {
    preflight: vi.fn(async () => {}), connectSquire: vi.fn(async () => 'existing' as const),
    setup: vi.fn(async () => ({})), installedSources: vi.fn(async () => ''),
    loadRegistry: vi.fn(async () => ({ registry: { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ids.includes(adapter.id)) }, origin: 'remote' as const })),
    approveDataSharing: vi.fn(async options => { options.notice?.('Data sharing on: nous. Off: GRUNT_SETUP_NO_DATA_SHARING=1'); return { approved: ids, skipped: [] }; }),
    installService: vi.fn(async () => {}), checkService: vi.fn(async () => {}),
    checkServiceSources: vi.fn(async () => {}), checkFallbackServices: vi.fn(async () => {}),
    connectHarnesses: vi.fn(async () => []), setupFallbacks: signups,
    chooseHarness: vi.fn(async () => HARNESSES[0]!), connectHarness: vi.fn(async () => ({ change: undefined, answer: 'ready' })),
    signupHarness: vi.fn(() => async () => {}), probeOperator: vi.fn(async () => true), createSquire: () => squire
  });
  const text = screen.text();
  const at = (pattern: RegExp) => text.findIndex(line => pattern.test(line));
  const steps = [/^✓ harness: pi$/, /^✓ data sharing: on for nous\. Off: GRUNT_SETUP/, /^✓ local service: running on port \d+$/,
    /^✓ model: grunt \(kilo anonymous\)$/, /^✓ Trusty Squire: already set up and signed in, s/];
  const positions = steps.map(at);
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  for (const pattern of steps) expect(text.filter(line => pattern.test(line))).toHaveLength(1);
  // One header in scrollback plus screen, after every preliminary step.
  expect(text.filter(line => /^name\s+status$/.test(line))).toHaveLength(1);
  const header = at(/^name\s+status$/);
  expect(header).toBeGreaterThan(Math.max(...positions));
  // The rows sit directly under the header with nothing between them.
  expect(text.slice(header + 1, header + 5)).toEqual([
    expect.stringMatching(/^kilo\s+✓ ready · operator$/), expect.stringMatching(/^zro\s+✓ ready$/),
    expect.stringMatching(/^pollinations\s+✓ ready$/), expect.stringMatching(/^nous\s+needs you \(Nous login\)$/)
  ]);
  // The browser handoff printed while the table was paused, above the table.
  expect(at(/^Verify zro in your browser/)).toBeLessThan(header);
  expect(at(/^Finished verifying zro\? yes$/)).toBe(at(/^Verify zro in your browser/) + 1);
  // Output held during signups prints above the table at a pause, or below it
  // once the table is final. Each line appears once.
  for (const id of ids.slice(1)) expect(text.filter(line => line === `grunt setup: ${id}: debug`)).toHaveLength(1);
  const after = text.slice(header + 5);
  expect(after.slice(0, 2)).toEqual(['squire chatter for nous', 'grunt setup: nous: debug']);
  expect(after.slice(-2)).toEqual(['3 ready; needs you: nous', 'Ready']);
});

it('holds a line written between two redraws instead of leaving a second header', () => {
  const screen = new Screen(50);
  const table = new SetupTable(screen, { live: false, capture: [screen] });
  table.set('source', 'nous', 'connecting');
  table.start();
  screen.write('✓ squire: signed in\n');
  table.set('source', 'nous', 'needs you (Nous login)');
  expect(screen.text()).toEqual(['name status', 'nous needs you (Nous login)']);
  table.finish();
  expect(screen.text()).toEqual(['name status', 'nous needs you (Nous login)', '✓ squire: signed in']);
});

it('keeps row updates during a prompt and draws them once the prompt ends', async () => {
  const screen = new Screen(50);
  const table = new SetupTable(screen, { live: false, capture: [screen] });
  table.set('source', 'kilo', 'connecting');
  table.set('source', 'zro', 'connecting');
  table.start();
  await withTerminal(async () => {
    screen.write('Verify zro in your browser\n');
    table.set('source', 'kilo', '✓ ready');
    screen.write('Finished verifying zro? yes\n');
  });
  table.set('source', 'zro', '✓ ready');
  table.finish();
  expect(screen.text()).toEqual(['Verify zro in your browser', 'Finished verifying zro? yes', 'name status', 'kilo ✓ ready', 'zro  ✓ ready']);
});
