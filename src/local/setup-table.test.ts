import { afterEach, expect, it, vi } from 'vitest';
import { SetupTable, setupNote } from './setup-table.js';

afterEach(() => { vi.restoreAllMocks(); });

it('prints a note above the live table instead of under the next redraw', () => {
  const chunks: string[] = [];
  const output = { isTTY: true, write: (chunk: string) => { chunks.push(chunk); return true; } };
  vi.spyOn(console, 'log').mockImplementation(text => { chunks.push(`${String(text)}\n`); });
  const table = new SetupTable(output as never);
  table.set('source', 'kilo', 'connecting');
  setupNote('✓ model: grunt (kilo anonymous)');
  table.set('source', 'kilo', '✓ ready');
  // The note clears the old table first, then the table redraws below it.
  expect(chunks.slice(1)).toEqual([
    '\x1b[2A\x1b[J', '✓ model: grunt (kilo anonymous)\n',
    `\x1b[2Ktype    name                  status\n\x1b[2Ksource  kilo                  connecting\n`,
    `\x1b[2A`, `\x1b[2Ktype    name                  status\n\x1b[2Ksource  kilo                  ✓ ready\n`
  ]);
});

it('prints notes as plain lines when output is not a terminal', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const table = new SetupTable({ isTTY: false, write: () => true });
  table.note('grunt setup: zro: needs human verification', 'error');
  expect(log).toHaveBeenCalledExactlyOnceWith('grunt setup: zro: needs human verification');
});
