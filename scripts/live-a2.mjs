import { readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { createHash, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
const helper = new URL('./live-lib.mjs', import.meta.url);
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '639b05d0945063acfe2d91df7dcfeb3c5df7b20911006ff0a9a842c4d72fa562') throw Error('Helper hash mismatch');
const { proof } = await import(helper.href);
const p = await proof('stage-a2');
let changed = false;
try {
  const a = await p.load();
  await p.step('Validate reusable setup', async () => {
    const packed = await readFile('.local-proof/usemilo-0.4.0.tgz');
    if (createHash('sha256').update(packed).digest('hex') !== a.fingerprint) throw Error('Package hash mismatch');
    if (a.state !== join(p.home, '.config/milo-usemilo-final-1794367590480')) throw Error('Unexpected state');
    for (const file of ['runtime/dist/local/main.js', 'freellmapi/runner.mjs', 'freellmapi/source/server/dist/index.js']) await stat(join(a.state, file));
    const units = JSON.parse(await readFile(join(a.backup, 'snapshot.json'), 'utf8'));
    for (const unit of units) {
      if (!unit.present || !(await readFile(unit.path)).equals(await readFile(join(a.backup, unit.name)))) throw Error('Baseline unit changed');
    }
  });
  changed = true;
  await p.ctl('stop', 'milo-pi');
  await p.ctl('disable', 'milo-pi');
  await p.ctl('stop', 'milo');
  await p.ctl('stop', 'milo-router');
  await p.ctl('reset-failed', 'milo');
  const { installBackgroundService } = await import('../dist/local/wizard.js');
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(p.home, '.config');
  try {
    const PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const directory = join(a.state, 'freellmapi');
    await p.step('Wizard router unit', () => installBackgroundService('milo-router', join(directory, 'runner.mjs'), {
      MILO_CONFIG_DIR: a.state, MILO_ROUTER_ENTRY: join(directory, 'source/server/dist/index.js'),
      HOST: '127.0.0.1', PORT: '3003', NODE_ENV: 'production', FREEAPI_DB_PATH: join(directory, 'router.db'), PATH }));
    await p.step('Wizard Milo unit', () => installBackgroundService('milo', join(a.state, 'runtime/dist/local/main.js'), {
      MILO_FREELLMAPI_URL: 'http://127.0.0.1:3003/v1', MILO_CONFIG_DIR: a.state, MILO_PORT: '8788', MILO_SOURCES: 'freellmapi,opencode', PATH }));
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
  await p.step('Wait 15 seconds', () => new Promise(resolve => setTimeout(resolve, 15000)));
  await p.owns();
  if (await p.ctl('is-active', 'milo-router') !== 'active') throw Error('Router inactive');
  await p.step('Fresh marker A', async () => {
    await rm('.local-proof/marker-b.json', { force: true });
    await writeFile(p.marker, JSON.stringify({ ...a, appliedAt: new Date().toISOString() }), { mode: 0o600 });
  });
  console.log('PASS A2', a.backup);
} catch (error) {
  await p.log({ name: 'Original error before rollback', message: error.message, stack: error.stack });
  try {
    if (changed) {
      await p.rollback();
    }
  } catch (rollback) {
    await p.log({ name: 'Rollback error', message: rollback.message, stack: rollback.stack });
  } finally {
    await p.log({ name: 'Original error after rollback', message: error.message, stack: error.stack });
    console.error(error.message.replace(/(?:sqr_egress_|sk-)\S+/g, '[REDACTED]'));
    process.exitCode = 1;
  }
} finally { await p.close(); }
