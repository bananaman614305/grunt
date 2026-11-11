import { readFile, writeFile, rm, stat, cp, mkdtemp } from 'node:fs/promises';
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const helper = new URL('./live-lib.mjs', import.meta.url);
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '85a1ac9de383169abdfefe03831305665cf774bf15410d7af662efb0704def7d') throw Error('Helper hash mismatch');
const { proof } = await import(helper.href);
const p = await proof('stage-c');
let changed = false;
const models = join(p.home, '.pi/agent/models.json'), backup = p.path + '.models.json';
try {
  const a = await p.load();
  const b = JSON.parse(await readFile('.local-proof/marker-b.json', 'utf8'));
  if (b.marker !== p.marker || JSON.stringify(b.a) !== JSON.stringify(a)) throw Error('Marker B mismatch');
  const packed = await readFile('.local-proof/usemilo-0.4.0.tgz');
  if (createHash('sha256').update(packed).digest('hex') !== a.fingerprint) throw Error('Package hash mismatch');
  const dir = await mkdtemp('.local-proof/wizard-');
  await p.run('tar', ['-xzf', '.local-proof/usemilo-0.4.0.tgz', '-C', dir]);
  const deps = '.local-proof/usemilo-deps.tgz';
  if (createHash('sha256').update(await readFile(deps)).digest('hex') !== '402cc3ffbcda711396335e55f21d00f1f1c133822819d5b93189f7ff37c8e657') throw Error('Dependency hash mismatch');
  await p.run('tar', ['-xzf', deps, '-C', join(dir, 'package')]);
  const { configurePi } = await import(pathToFileURL(resolve(dir, 'package/dist/local/wizard.js')).href);
  await p.step('Snapshot current models', async () => writeFile(backup, await readFile(models), { mode: 0o600, flag: 'wx' }));
  changed = true;
  await p.step('Configure normal Pi', async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(p.home, '.pi/agent');
    try { await configurePi(); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
  await p.step('Verify normal provider', async () => deepStrictEqual(
    JSON.parse(await readFile(models)).providers.milo,
    JSON.parse(await readFile(join(a.piDir, 'models.json'))).providers.milo));
  p.env.PI_CODING_AGENT_DIR = join(p.home, '.pi/agent');
  const since = '@' + (Date.now() / 1000).toFixed(3);
  const reply = await p.run('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply exactly: Milo is ready']);
  if (!reply) throw Error('Normal Pi returned no answer');
  const logs = await p.run('journalctl', ['--user', '-u', 'milo', '--since', since, '--no-pager', '-o', 'cat']);
  const sources = logs.split('\n').filter(line => line.startsWith('Milo source:'));
  if (!sources.some(line => line.includes('freellmapi answered model milo'))) throw Error('Unexpected source');
  console.log('PASS C:', reply, sources.join('\n'));
  console.log('Services:', await p.ctl('is-active', 'milo', 'milo-router'), 'Backup:', a.backup);
} catch (error) {
  await p.log({ name: 'Error before rollback', message: error.message, stack: error.stack });
  try {
    if (changed) {
      try { await p.step('Restore normal Pi', () => cp(backup, models)); }
      catch (restore) { await p.log({ name: 'Models rollback error', message: restore.message, stack: restore.stack }); }
      await p.rollback();
    }
  } catch (rollback) {
    await p.log({ name: 'Rollback error', message: rollback.message, stack: rollback.stack });
  } finally {
    await p.log({ name: 'Error after rollback', message: error.message, stack: error.stack });
    console.error(error.message.replace(/(?:sqr_egress_|sk-)\S+/g, '[REDACTED]'));
    process.exitCode = 1;
  }
} finally { await p.close(); }
