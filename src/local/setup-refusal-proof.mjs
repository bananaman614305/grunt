// Exercise the built setup CLI with offline Squire and Docker stand-ins.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
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
  if (process.env.MILO_PROOF_CASE.startsWith('admin')) {
    if (name === 'list_credentials') return { credentials: [{ service: ' MILO-FREELLMAPI-ADMIN ', reference: 'admin', field_names: ['password', 'encryption_key'] }] };
    if (name === 'fetch_credential') {
      if (process.env.MILO_PROOF_CASE === 'admin-resume') {
        if (args.action !== 'resume' || args.approval_id !== 'admin') throw new Error('Unexpected replacement approval');
        return { status: 'credential_fetched', fields: { password: 'SyntheticAdmin!42', encryption_key: 'SyntheticEncryption!42' } };
      }
      const id = process.env.MILO_PROOF_CASE === 'admin-expired' ? 'renewed' : 'admin';
      return { approval_id: id, approval_url: 'https://approval.test/' + id };
    }
    throw new Error('Unexpected vault write: existing router credentials must be reused');
  }
  if (name === 'list_credentials') return { credentials: process.env.MILO_PROOF_CASE === 'reuse' ? [
    { service: 'Groq', reference: 'groq', field_names: ['value'] }
  ] : [] };
  if (name === 'store_credential') return {};
  if (name === 'fetch_credential') return args.action === 'start'
    ? { approval_id: args.reference, approval_url: 'https://approval.test/load' }
    : { status: 'credential_fetched', fields: { api_key: process.env.MILO_PROOF_SECRET } };
  if (process.env.MILO_PROOF_CASE === 'reuse') throw new Error('Unexpected signup: existing vault keys must be reused');
  if (name === 'operate_drive') return process.env.MILO_PROOF_CASE === 'policy'
    ? { status: 'needs_value', session_id: 'offline', remaining: 'Review the privacy policy and enter the SMS code.' }
    : { status: 'stuck', session_id: 'offline', reason: process.env.MILO_PROOF_REASON || 'Provider denied automated account creation.', remaining: process.env.MILO_PROOF_REASON ? '' : 'api_key=' + process.env.MILO_PROOF_SECRET };
  throw new Error('Unexpected Squire call in offline proof');
};
FreeLLMAdmin.prototype.login = async () => {};
FreeLLMAdmin.prototype.configureChain = async excluded => {
  if (process.env.MILO_PROOF_CASE === 'admin-resume') throw new Error('Offline proof complete: saved approval resumed without a new prompt');
  if (process.env.MILO_PROOF_CASE === 'policy' && excluded?.includes('groq')) console.log('groq: disabled in active chain');
};
FreeLLMAdmin.prototype.addKey = async function(provider, key) {
  if (key !== process.env.MILO_PROOF_SECRET) throw new Error('Wrong offline vault key');
  console.log(provider + ': existing vault key imported');
};
FreeLLMAdmin.prototype.key = async () => { throw new Error('Offline proof complete: existing vault keys imported'); };
`);
const run = async (scenario, reason = '') => {
  const child = spawn(process.execPath, ['--import', hook, 'dist/local/main.js', 'setup'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_CONFIG_HOME: join(dir, scenario.startsWith('admin') ? 'admin' : scenario), MILO_PROOF_CASE: scenario, MILO_PROOF_SECRET: secret, MILO_PROOF_REASON: reason }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1, 'setup stops before starting the daemon');
  for (const output of [stdout, stderr]) {
    for (const value of [secret, 'SyntheticPass!42', 'SyntheticToken!42', 'Synthetic Secret!42', 'SyntheticAdmin!42', 'SyntheticEncryption!42']) assert(!output.includes(value), 'synthetic credential never appears in either CLI output stream');
  }
  return (stdout + stderr).trim();
};
try {
  const refusal = await run('refusal');
  assert(refusal.includes('Provider denied automated account creation.'), 'CLI preserves the non-secret provider refusal reason');
  const secretDescriptions = [];
  for (const reason of [
    'Provider denied automated account creation. password is SyntheticPass!42.',
    'Provider denied automated account creation. your token was "SyntheticToken!42".',
    "Provider denied automated account creation. secret = 'Synthetic Secret!42'"
  ]) {
    const output = await run('refusal', reason);
    assert(output.endsWith('Provider refused groq signup; setup stopped'), 'ambiguous secret-bearing reason is omitted entirely');
    secretDescriptions.push(output);
  }
  const policy = await run('policy');
  assert(policy.includes('groq: dropped') && policy.includes('SMS code') && policy.includes('groq: disabled in active chain') && !policy.includes('https://approval.test/sms'), 'SMS signup is dropped without an approval link and its provider is disabled');
  const vaultReuse = await run('reuse');
  assert(vaultReuse.includes('groq: existing vault key imported'), 'existing Groq key is loaded');
  assert(!vaultReuse.includes('mistral') && !vaultReuse.includes('nvidia'), 'removed SMS providers are never set up');
  assert(!vaultReuse.includes('Unexpected signup'), 'existing keys prevent browser signup');
  const adminReuse = await run('admin');
  assert(adminReuse.includes('Approve local FreeLLMAPI access: https://approval.test/admin') && !adminReuse.includes('Unexpected vault write'), 'router credential lookup also ignores service case and whitespace');
  const statePath = join(dir, 'admin', 'milo', 'approvals.json');
  const saved = await readFile(statePath, 'utf8');
  assert(saved.includes('admin') && saved.includes('createdAt'), 'approval metadata was saved before the original process stopped');
  const adminResume = await run('admin-resume');
  assert(adminResume.includes('saved approval resumed without a new prompt') && !adminResume.includes('Approve local FreeLLMAPI access'), 'a second setup process resumes the approval without another prompt');
  assert(!(await readFile(statePath, 'utf8')).includes('Synthetic'), 'no fetched secret is persisted');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).length, 0, 'successful delivery removes the saved entry');
  const expired = JSON.parse(saved);
  for (const entry of expired) { entry.createdAt = 0; entry.expiresAt = 0; }
  await writeFile(statePath, JSON.stringify(expired));
  const adminExpired = await run('admin-expired');
  assert(adminExpired.includes('https://approval.test/renewed'), 'an expired approval is replaced');
  console.log(JSON.stringify({ reproduction: 'setup-refusal-detail', approvalReproduction: 'setup-approval-restart', target: 'built setup CLI with offline dependencies', refusal, secretDescriptions, droppedSignup: policy, vaultReuse, adminReuse, adminResume, adminExpired, providerSecretPrinted: false }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
