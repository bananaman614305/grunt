type Output = Pick<NodeJS.WriteStream, 'write' | 'isTTY'> & { columns?: number };

// Keep every row shorter than the terminal. A wrapped row takes two screen
// lines, so moving the cursor up by the row count would overwrite other rows.
function fit(text: string, width: number) {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

// One terminal region for setup. Pipes receive each completed row once.
export class SetupTable {
  private rows = new Map<string, { kind: string; name: string; status: string }>();
  private drawn: string[] = [];
  private started = false;
  constructor(private output: Output = process.stdout) {}
  set(kind: 'tool' | 'source', name: string, status: string) {
    this.rows.set(`${kind}:${name}`, { kind, name, status });
    if (this.output.isTTY) this.draw();
    else if (status !== 'connecting') {
      if (!this.started) { this.output.write('type    name                  status\n'); this.started = true; }
      this.output.write(this.line(kind, name, status) + '\n');
    }
  }
  private line(kind: string, name: string, status: string) {
    return `${kind.padEnd(7)} ${name.padEnd(21)} ${status}`;
  }
  private width() {
    const columns = this.output.columns;
    return columns && columns > 0 ? columns : 80;
  }
  private lines(columns: number) {
    const rows = [...this.rows.values()];
    // Leave the last column empty: some terminals wrap when it is written.
    const width = Math.max(1, columns - 1);
    if (columns >= 80) {
      return ['type    name                  status', ...rows.map(row => this.line(row.kind, row.name, row.status))].map(line => fit(line, width));
    }
    // Narrow terminals (phones) drop the type column and shorten the name.
    const nameWidth = Math.min(Math.max(4, ...rows.map(row => row.name.length)), Math.max(4, Math.floor(width / 3)));
    return [`${'name'.padEnd(nameWidth)} status`, ...rows.map(row => `${fit(row.name, nameWidth).padEnd(nameWidth)} ${row.status}`)]
      .map(line => fit(line, width));
  }
  private draw() {
    const columns = this.width();
    const lines = this.lines(columns);
    // Count screen rows of the last frame at the current width, in case the
    // terminal was narrowed since then.
    const height = this.drawn.reduce((total, line) => total + Math.max(1, Math.ceil([...line].length / columns)), 0);
    let frame = height ? `\x1b[${height}A\r` : '';
    frame += lines.map(line => `\x1b[2K${line}\n`).join('');
    // Clear anything left below a shorter frame.
    frame += '\x1b[J';
    this.output.write(frame);
    this.drawn = lines;
  }
}
