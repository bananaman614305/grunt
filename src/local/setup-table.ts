// Print a line above the live setup table, so a redraw does not overwrite it.
export function setupNote(text: string, stream: 'log' | 'error' = 'log') {
  if (SetupTable.current) SetupTable.current.note(text, stream);
  else console[stream](text);
}
// One terminal region for setup. Pipes receive each completed row once.
export class SetupTable {
  static current: SetupTable | undefined;
  private rows = new Map<string, { kind: string; name: string; status: string }>();
  private height = 0;
  private started = false;
  constructor(private output: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stdout) { SetupTable.register(this); }
  private static register(table: SetupTable) { SetupTable.current = table; }
  note(text: string, stream: 'log' | 'error' = 'log') {
    if (!this.output.isTTY || !this.height) { console[stream](text); return; }
    this.output.write(`\x1b[${this.height}A\x1b[J`);
    this.height = 0;
    console[stream](text);
    this.draw();
  }
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
  private draw() {
    const lines = ['type    name                  status', ...[...this.rows.values()].map(row => this.line(row.kind, row.name, row.status))];
    if (this.height) this.output.write(`\x1b[${this.height}A`);
    this.output.write(lines.map(line => `\x1b[2K${line}\n`).join(''));
    this.height = lines.length;
  }
}
