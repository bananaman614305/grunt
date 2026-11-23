// Clean-config built wizard stand-in. No real OS service or Google account is changed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { BrowserSquire } from '../../dist/local/setup.js';
import { setupFallbacks } from '../../dist/local/fallback-setup.js';
import { wizard, configurePi, checkService, checkFallbackServices, preflight } from '../../dist/local/wizard.js';
import { Sources } from '../../dist/local/source.js';
import { createLocalApp } from '../../dist/local/api.js';
import { bundledRegistry } from '../../dist/registry.js';

const directory = await mkdtemp(join(tmpdir(), 'grunt-installer-proof-'));
const saved = { ...process.env };
const events = []; const installed = new Set(); let signedIn = false; let verified = false; let googleSignins = 0; let service;
const squire = new BrowserSquire({ background: true });
squire.call = async (name, args) => {
  if (name === 'operate_drive') {
    if (!verified) { verified = true; events.push('human verification requested'); return { status: 'needs_value', session_id: 'proof', field: 'captcha' }; }
    events.push('same browser session resumed'); return { status: 'complete', session_id: args.session_id };
  }
  if (name === 'operate_finish') return {};
  throw new Error('Unexpected Squire operation in offline proof');
};
const run = async (binary, args) => {
  if (args[0] === '--version' && ['freebuff', 'opencode'].includes(binary) && !installed.has(binary)) throw new Error('missing');
  if (binary === 'npm' && args[0] === 'install') { installed.add(args.at(-1) === 'opencode-ai' ? 'opencode' : args.at(-1)); events.push(`installed ${args.at(-1)}`); }
};
try {
  process.env.GRUNT_CONFIG_DIR = directory; process.env.PI_CODING_AGENT_DIR = join(directory, 'pi');
  await wizard(undefined, {
    preflight: () => preflight(run),
    connectSquire: async () => { googleSignins++; events.push('local broker installed; one Google session connected (stand-in)'); },
    setup: async () => { throw new Error('Launch installer must not provision unrelated providers'); },
    loadRegistry: async () => ({ registry: bundledRegistry, origin: 'bundled' }),
    setupFallbacks: options => setupFallbacks({ ...options, run, squire, signedIn: async () => signedIn,
      login: async browser => { await browser.signup('freebuff', 'https://freebuff.example.test/login', 'Pair free account'); signedIn = true; }, verify: async () => {} }),
    installService: async () => {
      assert(signedIn && installed.has('opencode')); events.push('daemon started after adapter setup (stand-in)');
      const calls = [];
      const sources = new Sources(['freebuff', 'opencode'].map(id => ({ id, available: async () => true, complete: async () => { calls.push(id); return { text: `${id} ready` }; } })), { registry: () => bundledRegistry });
      let local; const app = new Hono(); app.all('*', c => local.fetch(c.req.raw));
      service = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      await new Promise(resolve => service.once('listening', resolve));
      process.env.GRUNT_PORT = String(service.address().port); local = createLocalApp(sources, { port: service.address().port });
      events.push(calls);
    },
    configurePi, checkService, checkFallbackServices
  });
  assert.deepEqual(events.find(Array.isArray), ['freebuff', 'opencode'], 'each adapter gets its own task and verification');
  const pi = JSON.parse(await readFile(join(directory, 'pi/models.json'), 'utf8'));
  assert.equal(pi.providers.grunt.baseUrl, `http://127.0.0.1:${process.env.GRUNT_PORT}/v1`);
  assert.equal(googleSignins, 1);
  assert(events.includes('same browser session resumed'));
  console.log(JSON.stringify({ proof: 'grunt-installer-v1', mode: 'clean-config stand-in with fake Squire and OS service', googleSignins, pi: 'grunt provider written; unrelated providers not provisioned', adapters: 'both verified through built HTTP service', humanHandoff: 'shown and resumed before daemon start', events }, null, 2));
} finally {
  if (service) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  await rm(directory, { recursive: true, force: true });
}
