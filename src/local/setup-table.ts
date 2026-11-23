import { observeTerminal } from './terminal.js';

type Output = Pick<NodeJS.WriteStream, 'write' | 'isTTY'> & { columns?: number };
type Input = Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'>;
type Stream = Pick<NodeJS.WriteStream, 'write'>;
type Write = NodeJS.WriteStream['write'];

// Keep every row shorter than the terminal. A wrapped row takes two screen
// lines, so moving the cursor up by the row count would overwrite other rows.
function fit(text: string, width: number) {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

export interface SetupTableOptions {
  // false: collect rows but draw nothing until start(). Setup prints its
  // preliminary steps first and shows the table only for the signups.
  live?: boolean;
  // Streams whose other writes are held while the table is live, so nothing
  // lands between two redraws. Defaults to stdout and stderr for stdout.
  capture?: Stream[];
  // Keys pressed while the table is live. Defaults to stdin for stdout.
  input?: Input;
}

// One terminal region for setup. Pipes receive each completed row once.
export class SetupTable {
  private rows = new Map<string, { kind: string; name: string; status: string }>();
  private drawn: string[] = [];
  private started = false;
  private live: boolean;
  private status = '';
  private held: string[] = [];
  private hooks: { stream: Stream; write: Write }[] = [];
  private write: (text: string) => void;
  private capture: Stream[];
  private stopObserving: (() => void) | undefined;
  private paused = false;
  private done = false;
  private input: Input | undefined;
  private raw = false;
  private stopKeys: (() => void) | undefined;
  constructor(private output: Output = process.stdout, options: SetupTableOptions = {}) {
    this.live = options.live ?? true;
    this.capture = options.capture ?? (output === process.stdout ? [process.stdout, process.stderr] : []);
    this.input = options.input ?? (output === process.stdout ? process.stdin : undefined);
    const write = output.write;
    this.write = text => { write.call(output, text); };
  }
  set(kind: 'tool' | 'source', name: string, status: string) {
    this.rows.set(`${kind}:${name}`, { kind, name, status });
    if (!this.live) return;
    // While a prompt owns the terminal, keep the update and draw on resume.
    if (this.output.isTTY) { if (!this.done && !this.paused) this.draw(); }
    else if (status !== 'connecting' && !status.startsWith('waiting')) this.printRow(kind, name, status);
  }
  rowsWith(prefix: string) {
    return [...this.rows.values()].filter(row => row.status.startsWith(prefix)).map(row => row.name);
  }
  // Show the table and keep it in one place until finish().
  start() {
    if (this.live) return;
    this.live = true;
    if (!this.output.isTTY) {
      for (const row of this.rows.values()) if (row.status !== 'connecting' && !row.status.startsWith('waiting')) this.printRow(row.kind, row.name, row.status);
      return;
    }
    this.hook();
    // A prompt (for example browser verification) owns the terminal: remove
    // the table, let the prompt print, then draw the table again below it.
    this.stopObserving = observeTerminal(busy => {
      if (busy && !this.paused) {
        this.paused = true;
        this.erase();
        this.unhook();
        this.flush();
      } else if (!busy && this.paused) {
        this.paused = false;
        this.hook();
        this.draw();
      }
    });
    this.captureKeys();
    if (!this.paused) this.draw();
  }
  // From now until finish(), keys pressed on the terminal are read and ignored
  // instead of echoing into setup's output. A prompt that owns the terminal
  // gets stdin back in its normal mode.
  captureKeys() {
    if (this.stopKeys || this.done || !this.output.isTTY) return;
    this.stopKeys = observeTerminal(busy => { if (busy) this.release(); else this.listen(); });
  }
  // A key pressed in cooked mode echoes into setup's output (an arrow key prints
  // ^[OA). Read keys in raw mode and ignore them; Ctrl+C still interrupts setup.
  private key = (data: Buffer) => {
    if (!data.includes(3)) return;
    this.release();
    process.kill(process.pid, 'SIGINT');
  };
  private listen() {
    if (this.raw || !this.input?.isTTY) return;
    this.input.setRawMode(true);
    this.raw = true;
    this.input.on('data', this.key);
    this.input.resume();
  }
  private release() {
    if (!this.raw || !this.input) return;
    this.input.off('data', this.key);
    this.input.setRawMode(false);
    this.input.pause();
    this.raw = false;
  }
  // A setup step that happens while the table is live: one status line inside
  // the table region. Before start() it is a plain line.
  step(line: string) {
    if (!this.live || this.done) { console.log(line); return; }
    if (!this.output.isTTY) { this.write(`${line}\n`); return; }
    this.status = line;
    if (!this.paused) this.draw();
  }
  // Draw the final table and print anything held while it was live.
  finish() {
    // Keys go back to the terminal even when the table never went live.
    this.stopKeys?.();
    this.release();
    if (!this.live || this.done) return;
    this.done = true;
    if (!this.output.isTTY) return;
    this.stopObserving?.();
    this.stopObserving = undefined;
    if (!this.paused) { this.status = ''; this.draw(); }
    this.paused = false;
    this.unhook();
    this.drawn = [];
    this.flush();
    const columns = this.width();
    const lines = this.lines(columns);
    for (const [index, row] of [...this.rows.values()].entries()) {
      if ([...lines[index + 1]!].length > Math.max(1, columns - 1)) {
        this.write(`${row.name}: ${row.status}\n`);
      }
    }
  }
  private printRow(kind: string, name: string, status: string) {
    if (!this.started) { this.write('type    name                  status\n'); this.started = true; }
    this.write(this.line(kind, name, status) + '\n');
  }
  private hook() {
    for (const stream of this.capture) {
      const write = stream.write;
      this.hooks.push({ stream, write });
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        this.held.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        const callback = rest.find(item => typeof item === 'function') as (() => void) | undefined;
        if (callback) queueMicrotask(callback);
        return true;
      }) as Write;
    }
  }
  private unhook() {
    for (const { stream, write } of this.hooks.splice(0).reverse()) stream.write = write;
  }
  private flush() {
    const held = this.held.splice(0).join('');
    if (held) this.write(held.endsWith('\n') ? held : `${held}\n`);
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
    const status = this.status ? [this.status] : [];
    if (columns >= 80) {
      return ['type    name                  status', ...rows.map(row => this.line(row.kind, row.name, row.status)), ...status];
    }
    // Narrow terminals (phones) drop the type column and shorten the name.
    const nameWidth = Math.min(Math.max(4, ...rows.map(row => row.name.length)), Math.max(4, Math.floor(width / 3)));
    return [`${'name'.padEnd(nameWidth)} status`, ...rows.map(row => `${fit(row.name, nameWidth).padEnd(nameWidth)} ${row.status}`), ...status];
  }
  // Rows of the last frame at the current width, in case the terminal was
  // narrowed since then.
  private height(columns: number) {
    return this.drawn.reduce((total, line) => total + Math.max(1, Math.ceil([...line].length / columns)), 0);
  }
  private erase() {
    const height = this.height(this.width());
    if (height) this.write(`\x1b[${height}A\r\x1b[J`);
    this.drawn = [];
  }
  private draw() {
    const columns = this.width();
    const lines = this.lines(columns).map(line => fit(line, Math.max(1, columns - 1)));
    const height = this.height(columns);
    let frame = height ? `\x1b[${height}A\r` : '';
    frame += lines.map(line => `\x1b[2K${line}\n`).join('');
    // Clear anything left below a shorter frame.
    frame += '\x1b[J';
    this.write(frame);
    this.drawn = lines;
  }
}
