// Run after pnpm build with an already signed-in official codex CLI on PATH.
import { serve } from '@hono/node-server';
import { createLocalApp } from '../../dist/local/api.js';
import { configure } from '../../dist/local/main.js';
const sources = configure();
const codex = sources.sources.find(source => source.id === 'codex');
if (!await codex.available()) throw new Error('An existing ChatGPT Codex login is required; no sign-in attempted');
const options = { port: 0 };
const server = serve({ fetch: createLocalApp(sources, options).fetch, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
options.port = server.address().port;
try {
  for (const model of ['milo', 'codex']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, cwd: process.cwd(), messages: [{ role: 'user', content: 'Reply with exactly: codex bridge works. Do not use tools.' }] })
    });
    const body = await response.json();
    if (!response.ok || !body.choices?.[0]?.message?.content?.includes('codex bridge works')) throw new Error(`Proof failed for ${model}: HTTP ${response.status}`);
    console.log(JSON.stringify({ model, status: response.status, text: body.choices[0].message.content }));
  }
} finally { await sources.close(); await new Promise(resolve => server.close(resolve)); }
