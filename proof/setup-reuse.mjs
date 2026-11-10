// Run after pnpm build: node --experimental-test-module-mocks proof/setup-reuse.mjs
// Offline proof for the built setup path: no Docker or Squire process is started.
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mock } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const Database = createRequire(import.meta.resolve('@trusty-squire/mcp'))('better-sqlite3');
const root = await mkdtemp(join(tmpdir(), 'milo-setup-proof-'));
const data = join(root, 'volume');
const dbPath = join(data, 'freeapi.db');
let installed = false, volume = false, password, starts = 0, imports = 0;
const commands = [], squireCalls = [], output = [];
const withDb = action => {
  const db = new Database(dbPath);
  try { return action(db); } finally { db.close(); }
};
const initialize = () => {
  mkdirSync(data, { recursive: true });
  withDb(db => {
    db.exec('CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, platform TEXT, label TEXT)');
    db.prepare("INSERT INTO api_keys(platform, label) VALUES ('custom', ?)").run('Kilo Free');
    db.prepare("INSERT INTO api_keys(platform, label) VALUES ('custom', ?)").run('Freebuff');
  });
};
const docker = async (command, args, options) => {
  assert.equal(command, 'docker');
  commands.push(args);
  if (args[0] === 'inspect') {
    if (!installed) throw Object.assign(new Error('missing'), { stderr: 'No such container' });
    return { stdout: '1' };
  }
  if (args[0] === 'volume' && args[1] === 'inspect') {
    if (!volume) throw Object.assign(new Error('missing'), { stderr: 'No such volume' });
  }
  if (args[0] === 'run' && args.includes('--rm')) {
    let stdout = '';
    // Execute the exact Docker metadata check against a real synthetic SQLite DB.
    runInNewContext(args.at(-1), {
      require(name) {
        if (name === 'node:fs') return {
          existsSync: path => existsSync(join(data, basename(path))),
          readdirSync: () => readdirSync(data)
        };
        assert.equal(name, 'better-sqlite3');
        return function (_path, opts) { return new Database(dbPath, opts); };
      },
      console: { log: value => { stdout += value; } }
    });
    return { stdout };
  }
  if (args[0] === 'rm') installed = false;
  if (args[0] === 'volume' && args[1] === 'rm') { rmSync(data, { recursive: true }); volume = false; }
  if (args[0] === 'run') {
    assert(args.includes('-d'));
    password = JSON.parse(options.env.FREEAPI_CONFIG_JSON).admin.password;
    installed = true; volume = true; initialize();
  }
  return { stdout: '' };
};
const mockedProcess = mock.module('node:child_process', { namedExports: { ...childProcess,
  execFile: Object.assign(() => { throw new Error('Unexpected subprocess'); }, { [promisify.custom]: docker })
} });
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  let response = {};
  if (req.url === '/api/auth/login') {
    assert.equal(body.password, password);
    response = { token: 'synthetic-login-token' };
  } else {
    assert.equal(req.headers.authorization, 'Bearer synthetic-login-token');
    if (req.url === '/api/keys' && req.method === 'GET') response = withDb(db => db.prepare('SELECT * FROM api_keys').all());
    if (req.url === '/api/keys' && req.method === 'POST') {
      assert.equal(body.key, 'synthetic-groq-key');
      imports++;
      withDb(db => db.prepare('INSERT INTO api_keys(platform, label) VALUES (?, ?)').run(body.platform, body.label));
    }
    if (req.url === '/api/fallback' && req.method === 'GET') response = [];
    if (req.url === '/api/settings/api-key') response = { apiKey: 'synthetic-router-key' };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
});
try {
  process.env.MILO_CONFIG_DIR = root;
  process.env.XDG_CONFIG_HOME = root;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { BrowserSquire, FreeLLMAdmin, setup } = await import('../dist/local/setup.js');
  const originalCall = FreeLLMAdmin.prototype.call;
  FreeLLMAdmin.prototype.call = function (...args) {
    this.url = `http://127.0.0.1:${server.address().port}`;
    return originalCall.apply(this, args);
  };
  BrowserSquire.prototype.connect = async () => {};
  BrowserSquire.prototype.close = async () => {};
  BrowserSquire.prototype.call = async (name, args) => {
    squireCalls.push({ name, ...args });
    if (name === 'list_credentials') return { credentials: [
      { service: 'milo-freellmapi-admin', reference: 'vault://admin', field_names: ['password', 'encryption_key'] },
      { service: 'groq', reference: 'vault://groq', field_names: ['api_key'] }
    ] };
    assert.equal(name, 'fetch_credential');
    if (args.action === 'start') {
      assert.equal(args.reference, 'vault://groq'); starts++;
      return { approval_id: 'synthetic-approval', approval_url: 'https://squire.test/approve' };
    }
    return { status: 'credential_fetched', fields: { api_key: 'synthetic-groq-key' } };
  };
  assert.deepEqual(await setup(line => output.push(line)), { key: 'synthetic-router-key' });
  const local = (await readdir(root, { withFileTypes: true })).find(entry => entry.isFile() && entry.name !== 'approvals.json');
  const localPath = join(root, local.name);
  const saved = await readFile(localPath, 'utf8');
  assert.equal((await stat(localPath)).mode & 0o777, 0o600);
  const callsBefore = squireCalls.length;
  const linesBefore = output.length;
  assert.deepEqual(await setup(line => output.push(line)), { key: 'synthetic-router-key' });
  assert.equal(await readFile(localPath, 'utf8'), saved);
  assert.equal(squireCalls.length, callsBefore);
  assert.deepEqual(output.slice(linesBefore), ['groq: connected']);
  assert.equal(starts, 1); assert.equal(imports, 1);
  assert.equal(output.filter(line => line.includes('approve loading')).length, 1);
  assert(!output.join(' ').includes(JSON.parse(saved).password));
  console.log('Reproduction repeat-approvals: setup succeeds twice; admin state is private and reused; one provider approval/import, none on rerun.');

  await rm(localPath);
  const beforeGuard = commands.length;
  await assert.rejects(setup(() => {}), /provider keys.*preserv/i);
  assert(!commands.slice(beforeGuard).some(args => args[0] === 'rm' || args[0] === 'volume' && args[1] === 'rm'));
  console.log('Missing local admin state with provider keys: setup stops and preserves the old container and volume.');

  withDb(db => db.prepare("DELETE FROM api_keys WHERE label = 'Milo'").run());
  await setup(() => {});
  assert(commands.some(args => args[0] === 'volume' && args[1] === 'rm'));
  console.log('Missing local admin state without provider keys: setup replaces the old container and volume and completes with fresh local credentials.');
} finally {
  mockedProcess.restore();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
