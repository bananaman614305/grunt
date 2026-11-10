import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Multiplexer } from '../multiplexer.js';

// Persist both processes before allowing either send to return. A returns later,
// so matching by prompt alone deterministically swaps the two replies.
export class OwnershipMux implements Multiplexer {
  readonly sessions = new Map<string, { cwd: string; chat: string }>();
  private sends = 0;
  private release!: () => void;
  private both = new Promise<void>(resolve => { this.release = resolve; });
  constructor(private home: string) {}
  async start(id: string, cwd: string, _binary: string, continuation?: string) {
    this.sessions.set(id, { cwd, chat: continuation ?? `${basename(dirname(cwd))}-chat` });
  }
  async send(id: string, prompt: string) {
    const session = this.sessions.get(id)!;
    const folder = join(this.home, '.config/manicode/projects', basename(session.cwd), 'chats', session.chat);
    await mkdir(folder, { recursive: true });
    if (prompt === 'quota please') {
      await writeFile(join(folder, 'log.jsonl'), JSON.stringify({code:'quota',message:'Free hours exhausted'}));
    } else {
      const file = join(folder, 'chat-messages.json');
      let messages: unknown[] = [];
      try { messages = JSON.parse(await readFile(file, 'utf8')); } catch { /* fresh chat */ }
      messages.push({variant:'user',content:prompt},{variant:'ai',isComplete:true,blocks:[{type:'text',content:JSON.stringify(session)}]});
      await writeFile(file, JSON.stringify(messages));
    }
    if (++this.sends >= 2) this.release();
    await this.both;
    if (basename(dirname(session.cwd)) === 'A') await delay(100);
  }
  async stop() {}
}
