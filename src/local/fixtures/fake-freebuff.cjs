#!/usr/bin/env node
const testEnv = name => process.env['GRUNT_TEST_' + name] ?? process.env['MILO_TEST_' + name];
/* eslint-disable @typescript-eslint/no-require-imports */
// Offline TUI stand-in: accept bracketed paste on the PTY and persist Freebuff's real message shape.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.argv.includes('doctor')) { setTimeout(() => { process.stdout.write(testEnv('DOCTOR_ERROR') || 'Freebuff doctor: checks passed'); process.exit(0); }, Number(testEnv('DOCTOR_DELAY') || 0)); return; }
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
  const dir = path.join(testEnv('HOME'), '.config/manicode/projects', path.basename(cwd), 'chats', chatId);
  fs.mkdirSync(dir, { recursive: true });
  if (prompt.startsWith('STARTUP_')) {
    const code = prompt === 'STARTUP_LOGIN' ? 'logged_out' : 'quota';
    fs.writeFileSync(path.join(dir,'log.jsonl'),JSON.stringify({code,message:code === 'logged_out' ? 'Login required' : 'Free hours exhausted'})+'\n');
    return;
  }
  const file = path.join(dir, 'chat-messages.json');
  const messages = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  let reply = (testEnv('UNIQUE') || prompt === 'UNIQUE_REPLY') ? chatId : prompt;
  if (testEnv('JSON_BRIDGE') && prompt.startsWith('You are answering a Pi tool protocol')) {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    if (!JSON.stringify(payload.messages).includes('Never invent the nonce.')) throw new Error('Pi skill context was lost');
    const result = payload.messages.filter(m => m.role === 'tool').at(-1);
    reply = JSON.stringify(result ? {version:1,type:'final',text:result.content} : {version:1,type:'calls',calls:[{name:'read',arguments:{path:'nonce.txt'}}]});
  }
  messages.push({ variant: 'user', content: '', textAttachments: [{content: prompt}] }, { variant: 'ai', content: '', blocks: prompt === 'REFUSE' ? [] : [{ type: 'text', content: reply }], isComplete: true });
  if (testEnv('REASONING')) messages.at(-1).blocks.unshift({ type: 'text', content: 'private deliberation' }, { type: 'tool', name: 'read_files' });
  if (prompt === 'REFUSE') fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({status:403, code:'prompt_policy_refused', message:'Freebuff is not a worker for other agents.'}) + '\n');
  setTimeout(() => fs.writeFileSync(file, JSON.stringify(messages)), 40);
});
