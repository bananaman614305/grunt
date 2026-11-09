#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Offline TUI stand-in: accept bracketed paste on the PTY and persist Freebuff's real message shape.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
let input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
process.stdin.on('data', chunk => {
  input += chunk.toString();
  const end = input.indexOf('\x1b[201~');
  if (end < 0 || !input.slice(end + 6).includes('\r')) return;
  const prompt = input.slice(input.indexOf('\x1b[200~') + 6, end).replaceAll('\r', '\n');
  input = '';
  if (prompt.includes('NEVER_COMPLETE')) return;
  const dir = path.join(process.env.MILO_TEST_HOME, '.config/manicode/projects', path.basename(cwd), 'chats', crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chat-messages.json');
  const messages = [{ variant: 'user', content: prompt }, { variant: 'ai', content: '', blocks: [{ type: 'text', content: prompt.split('[user]\n').at(-1) }], isComplete: true }];
  setTimeout(() => fs.writeFileSync(file, JSON.stringify(messages)), 40);
});
