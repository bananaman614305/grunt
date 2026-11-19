import { expect, it } from 'vitest';
import { SetupTable } from './setup-table.js';

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
