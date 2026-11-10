#!/usr/bin/env node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login') {
  console.error(process.env.FAKE_CODEX_LOGIN || 'Logged in using ChatGPT');
  process.exit(process.env.FAKE_CODEX_LOGIN === 'Not logged in' ? 1 : 0);
}
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }) + '\n');
if (process.env.FAKE_CODEX_MODE === 'wait') { setInterval(() => {}, 1000); }
else {
  let prompt = '';
  process.stdin.on('data', chunk => prompt += chunk);
  process.stdin.on('end', () => {
    if (process.env.FAKE_CODEX_MODE === 'quota') { console.error('You have hit your usage limit'); process.exit(1); }
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-one' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  });
}
