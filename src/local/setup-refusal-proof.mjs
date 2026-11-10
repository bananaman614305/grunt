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
BrowserSquire.prototype.call = async function(name, args) {
  if (process.env.MILO_PROOF_CASE === 'admin') {
    if (name === 'list_credentials') return { credentials: [{ service: ' MILO-FREELLMAPI-ADMIN ', reference: 'admin', field_names: ['password', 'encryption_key'] }] };
    if (name === 'fetch_credential') return { approval_id: 'admin', approval_url: 'https://approval.test/admin' };
    throw new Error('Unexpected vault write: existing router credentials must be reused');
  }
  if (name === 'list_credentials') return { credentials: process.env.MILO_PROOF_CASE === 'reuse' ? [
    { service: 'Groq', reference: 'groq', field_names: ['value'] },
    { service: 'Mistral', reference: 'mistral', field_names: ['apiKey'] },
    { service: 'NVIDIA', reference: 'nvidia', field_names: ['value'] }
  ] : [] };
  if (name === 'store_credential') return {};
  if (name === 'fetch_credential') return args.action === 'start'
    ? { approval_id: args.reference, approval_url: 'https://approval.test/load' }
    : { status: 'credential_fetched', fields: { api_key: process.env.MILO_PROOF_SECRET } };
  if (process.env.MILO_PROOF_CASE === 'reuse') throw new Error('Unexpected signup: existing vault keys must be reused');
  if (name === 'operate_drive') return process.env.MILO_PROOF_CASE === 'policy'
    ? { status: 'needs_value', session_id: 'offline', remaining: 'Review the privacy policy and enter the SMS code.' }
    : { status: 'stuck', session_id: 'offline', reason: 'Provider denied automated account creation.', remaining: 'api_key=' + process.env.MILO_PROOF_SECRET };
  throw new Error('Unexpected Squire call in offline proof');
};
FreeLLMAdmin.prototype.login = async () => {};
FreeLLMAdmin.prototype.configureChain = async () => {};
FreeLLMAdmin.prototype.addKey = async function(provider, key) {
  if (key !== process.env.MILO_PROOF_SECRET) throw new Error('Wrong offline vault key');
  console.log(provider + ': existing vault key imported');
};
FreeLLMAdmin.prototype.key = async () => { throw new Error('Offline proof complete: existing vault keys imported'); };
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
  const vaultReuse = await run('reuse');
  for (const provider of ['groq', 'mistral', 'nvidia']) assert(vaultReuse.includes(`${provider}: existing vault key imported`), 'existing provider key is loaded');
  assert(!vaultReuse.includes('Unexpected signup'), 'existing keys prevent browser signup');
  const adminReuse = await run('admin');
  assert(adminReuse.includes('Approve local FreeLLMAPI access: https://approval.test/admin') && !adminReuse.includes('Unexpected vault write'), 'router credential lookup also ignores service case and whitespace');
  console.log(JSON.stringify({ reproduction: 'setup-refusal-detail', target: 'built setup CLI with offline dependencies', refusal, humanHandoff: policy, vaultReuse, adminReuse, providerSecretPrinted: false }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
