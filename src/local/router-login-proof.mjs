// Built HTTP-path stand-in for router login recovery.
// Real Pi deployment follows merge; all credentials here are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { configure } from '../../dist/local/main.js';
import { createLocalApp } from '../../dist/local/api.js';

const dir = await mkdtemp(join(tmpdir(), 'grunt-router-proof-'));
process.env.GRUNT_CONFIG_DIR = dir;
const password = 'a'.repeat(64);
await writeFile(join(dir, 'router-admin.json'), JSON.stringify({ password, encryption: 'b'.repeat(64) }), { mode: 0o600 });
let online = true, logins = 0;
const router = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
  if (!online) return new Response('', { status: 503 });
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/login') {
    assert.equal((await request.json()).password, password);
    logins++;
    return Response.json({ token: 'synthetic-admin-session' });
  }
  if (path === '/api/settings/api-key') {
    assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-admin-session');
    return Response.json({ apiKey: 'synthetic-router-key' });
  }
  if (path === '/api/fallback' || path === '/api/keys') {
    assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-admin-session');
    return Response.json([]);
  }
  assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-router-key');
  return Response.json(path === '/v1/models' ? { data: [] } : { choices: [{ message: { content: 'router answered' } }] });
} });
await new Promise(resolve => router.on('listening', resolve));
const env = { GRUNT_CONFIG_DIR: dir, GRUNT_SOURCES: 'freellmapi', GRUNT_FREELLMAPI_URL: `http://127.0.0.1:${router.address().port}/v1` };
let daemon;
try {
  for (const phase of ['first start', 'restart', 'router recovers']) {
    online = phase !== 'router recovers';
    const sources = configure(env);
    let app;
    daemon = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise(resolve => daemon.on('listening', resolve));
    app = createLocalApp(sources, { port: daemon.address().port });
    if (!online) {
      assert.equal(await sources.sources[0].available(), false);
      online = true;
    }
    const response = await fetch(`http://127.0.0.1:${daemon.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grunt', messages: [{ role: 'user', content: 'say hi' }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'router answered');
    console.log(`Router login proof: ${phase}: HTTP reply from freellmapi`);
    await sources.close();
    await new Promise(resolve => daemon.close(resolve));
    daemon = undefined;
  }
  // Loading the API key and enforcing managed-row sharing both authenticate.
  assert.equal(logins, 6);
} finally {
  daemon?.close(); router.close();
  await rm(dir, { recursive: true, force: true });
}
