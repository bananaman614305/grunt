// Exercise the built setup CLI with offline Squire and Docker stand-ins.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'milo-setup-detail-'));
const setupUrl = pathToFileURL(join(process.cwd(), 'dist/local/setup.js')).href;
const hook = join(dir, 'setup-proof-hook.mjs');
const secret = 'synthetic-hidden-provider-key';
await writeFile(join(dir, 'docker'), '#!/bin/sh\nif [ "$1" = inspect ]; then printf "1\\n"; fi\nexit 0\n');
await chmod(join(dir, 'docker'), 0o755);
await writeFile(hook, `
import { BrowserSquire, FreeLLMAdmin } from ${JSON.stringify(setupUrl)};
BrowserSquire.prototype.connect = async () => {};
BrowserSquire.prototype.close = async () => {};
BrowserSquire.prototype.humanHandoff = async () => 'https://approval.test/sms';
BrowserSquire.prototype.call = async function(name) {
  if (name === 'list_credentials') return { credentials: [] };
  if (name === 'store_credential') return {};
  if (name === 'operate_drive') return process.env.MILO_PROOF_CASE === 'policy'
    ? { status: 'needs_value', session_id: 'offline', remaining: 'Review the privacy policy and enter the SMS code.' }
    : { status: 'stuck', session_id: 'offline', reason: 'Provider denied automated account creation.', remaining: 'api_key=' + process.env.MILO_PROOF_SECRET };
  throw new Error('Unexpected Squire call in offline proof');
};
FreeLLMAdmin.prototype.login = async () => {};
FreeLLMAdmin.prototype.configureChain = async () => {};
`);
const run = async scenario => {
  const child = spawn(process.execPath, ['--import', hook, 'dist/local/main.js', 'setup'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MILO_PROOF_CASE: scenario, MILO_PROOF_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1, 'setup stops before starting the daemon');
  assert(!output.includes(secret), 'provider key never appears in CLI output');
  return output.trim();
};
try {
  const refusal = await run('refusal');
  assert(refusal.includes('Provider denied automated account creation.'), 'CLI preserves the non-secret provider refusal reason');
  const policy = await run('policy');
  assert(policy.includes('https://approval.test/sms') && !policy.includes('Provider refused'), 'a privacy-policy/SMS handoff remains an approval');
  console.log(JSON.stringify({ reproduction: 'setup-refusal-detail', target: 'built setup CLI with offline dependencies', refusal, humanHandoff: policy, providerSecretPrinted: false }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
