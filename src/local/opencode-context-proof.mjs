// Live proof: normal configuration with inherited MCPs, then empty config/auth.
// No personal configuration is edited and no model response or secret is logged.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OpenCode } from '../../dist/local/opencode.js';
import { Sources } from '../../dist/local/source.js';
import { createLocalApp } from '../../dist/local/api.js';

if (!process.argv[2]) {
  // A fresh Node process per scenario also keeps HTTP connection pools isolated.
  for (const mode of ['inherited-config', 'empty-config-and-auth']) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `${mode} proof failed`);
  }
  process.exit(0);
}

const temporary = await mkdtemp(join(tmpdir(), 'grunt-opencode-live-'));
const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json');
const digest = async () => createHash('sha256').update(await readFile(config).catch(() => '')).digest('hex');
const original = await digest();
const environment = { ...process.env };
let completed = false;
try {
  for (const mode of [process.argv[2]]) {
    if (mode === 'empty-config-and-auth') {
      process.env.XDG_CONFIG_HOME = join(temporary, 'config');
      process.env.XDG_DATA_HOME = join(temporary, 'data');
      process.env.XDG_CACHE_HOME = join(temporary, 'cache');
      delete process.env.OPENCODE_CONFIG;
      delete process.env.OPENCODE_CONFIG_CONTENT;
    }
    const cwd = join(temporary, mode);
    await mkdir(cwd, { recursive: true });
    const token = randomBytes(12).toString('hex');
    await writeFile(join(cwd, 'verification.txt'), token);
    const driver = new OpenCode({ timeout: 60000 });
    const sources = new Sources([driver]);
    const app = createLocalApp(sources, { port: 8792 });
    const messages = [{ role: 'user', content: 'Read verification.txt in the working directory using your coding tools. Reply with only its exact contents. Do not change files.' }];
    const request = async messages => {
      const started = performance.now();
      const response = await app.request('http://127.0.0.1:8792/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'opencode', cwd, messages, stream: false })
      });
      const body = await response.json();
      assert.equal(response.status, 200, body.error?.message);
      assert.equal(response.headers.get('x-grunt-source'), 'opencode');
      const message = body.choices[0].message;
      assert.equal(message.content.trim(), token);
      console.log(JSON.stringify({ mode, status: response.status, source: 'opencode', latencyMs: Math.round(performance.now() - started), result: 'verified' }));
      return message;
    };
    try {
      const reply = await request(messages);
      await request([...messages, reply, { role: 'user', content: 'Repeat the same verification value from the previous turn. Reply with only that value.' }]);
    } finally { await sources.close(); }
  }
  assert.equal(await digest(), original, 'Personal OpenCode configuration must remain unchanged');
  completed = true;
} finally {
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
  Object.assign(process.env, environment);
  if (completed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Proof state retained for diagnosis: ${temporary}`);
}
