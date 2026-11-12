#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Offline TUI stand-in: accept bracketed paste on the PTY and persist Freebuff's real message shape.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.argv.includes('doctor')) { setTimeout(() => { process.stdout.write(process.env.MILO_TEST_DOCTOR_ERROR || 'Freebuff doctor: checks passed'); process.exit(0); }, Number(process.env.MILO_TEST_DOCTOR_DELAY || 0)); return; }
const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
const continued = process.argv[process.argv.indexOf('--continue') + 1];
const chatId = process.argv.includes('--continue') ? continued : crypto.randomUUID();
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
  const dir = path.join(process.env.MILO_TEST_HOME, '.config/manicode/projects', path.basename(cwd), 'chats', chatId);
  fs.mkdirSync(dir, { recursive: true });
  if (prompt.startsWith('STARTUP_')) {
    const code = prompt === 'STARTUP_LOGIN' ? 'logged_out' : 'quota';
    fs.writeFileSync(path.join(dir,'log.jsonl'),JSON.stringify({code,message:code === 'logged_out' ? 'Login required' : 'Free hours exhausted'})+'\n');
    return;
  }
  const file = path.join(dir, 'chat-messages.json');
  const messages = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  messages.push({ variant: 'user', content: '', textAttachments: [{content: prompt}] }, { variant: 'ai', content: '', blocks: prompt === 'REFUSE' ? [] : [{ type: 'text', content: (process.env.MILO_TEST_UNIQUE || prompt === 'UNIQUE_REPLY') ? chatId : prompt }], isComplete: true });
  if (prompt === 'REFUSE') fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({status:403, code:'prompt_policy_refused', message:'Freebuff is not a worker for other agents.'}) + '\n');
  setTimeout(() => fs.writeFileSync(file, JSON.stringify(messages)), 40);
});
