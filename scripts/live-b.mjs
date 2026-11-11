import { readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { createHash, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
const helper = new URL('./live-lib.mjs', import.meta.url);
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '85a1ac9de383169abdfefe03831305665cf774bf15410d7af662efb0704def7d') throw Error('Helper hash mismatch');
const { proof } = await import(helper.href);
const { DatabaseSync } = await import('node:sqlite');
const p = await proof('stage-b');
let changed = false;
try {
  const a = await p.load();
  changed = true;
  await p.owns();
  await p.step('Profile HTTP preflight', async () => {
    const profile = JSON.parse(await readFile(join(a.piDir, 'models.json'), 'utf8')).providers.milo;
    // Pinned package/dist/local/api.js:151 serves GET /v1/models (loopback Host).
    const response = await fetch(profile.baseUrl.replace(/\/$/, '') + '/models', {
      headers: profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    if (!response.ok) throw Error(`Preflight HTTP ${response.status}: ${body}`);
    return `${response.status} ${body}`;
  });
  p.env.PI_CODING_AGENT_DIR = a.piDir;
  const since = '@' + (Date.now() / 1000).toFixed(3);
  const reply = await p.run('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply exactly: Milo is ready']);
  if (!reply) throw Error('Pi returned no answer');
  const logs = await p.run('journalctl', ['--user', '-u', 'milo', '--since', since, '--no-pager', '-o', 'cat']);
  const sources = logs.split('\n').filter(line => line.startsWith('Milo source:'));
  if (!sources.some(line => line.includes('freellmapi answered model milo'))) throw Error('Pi used an unexpected source');
  const attempts = await p.step('FreeLLMAPI token-only proof', async () => {
    const path = join(a.state, 'freellmapi/router.db');
    if (((await stat(path)).mode & 0o777) !== 0o600) throw Error('Router DB is not private');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const admin = JSON.parse(await readFile(join(a.state, 'router-admin.json'), 'utf8'));
      const keys = db.prepare('SELECT platform,label,base_url,encrypted_key,iv,auth_tag FROM api_keys').all();
      if (keys.length !== 1) throw Error('Unexpected provider entries');
      for (const key of keys) {
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(admin.encryption, 'hex'), Buffer.from(key.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(key.auth_tag, 'hex'));
        const token = decipher.update(key.encrypted_key, 'hex', 'utf8') + decipher.final('utf8');
        if (!token.startsWith('sqr_egress_') || key.platform !== 'custom') throw Error('Router holds an unexpected credential type');
      }
      return db.prepare('SELECT model_id,outcome,key_label FROM request_attempts ORDER BY id DESC LIMIT 4').all();
    } finally { db.close(); }
  });
  await p.step('Write marker B', () => writeFile('.local-proof/marker-b.json', JSON.stringify({ marker: p.marker, a }), { mode: 0o600 }));
  console.log('PASS B:', reply, sources.join('\n'), JSON.stringify(attempts));
} catch (error) {
  await p.log({ name: 'Error before rollback', message: error.message, stack: error.stack });
  try {
    if (changed) await p.rollback();
  } catch (rollback) {
    await p.log({ name: 'Rollback error', message: rollback.message, stack: rollback.stack });
  } finally {
    await p.log({ name: 'Error after rollback', message: error.message, stack: error.stack });
    console.error(error.message.replace(/(?:sqr_egress_|sk-)\S+/g, '[REDACTED]'));
    process.exitCode = 1;
  }
} finally { await p.close(); }
