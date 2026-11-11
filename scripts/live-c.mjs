import { readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { createHash, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
const helper = new URL('./live-lib.mjs', import.meta.url);
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '639b05d0945063acfe2d91df7dcfeb3c5df7b20911006ff0a9a842c4d72fa562') throw Error('Helper hash mismatch');
const { proof } = await import(helper.href);
const p = await proof('stage-c');
let changed = false, a;
try {
  a = await p.load();
  const b = JSON.parse(await readFile('.local-proof/marker-b.json', 'utf8'));
  if (b.marker !== p.marker || JSON.stringify(b.a) !== JSON.stringify(a)) throw Error('Marker B mismatch');
  const { configurePi } = await import('../dist/local/wizard.js');
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
  const reply = await p.run('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply exactly: Milo is ready'], { PI_CODING_AGENT_DIR: join(p.home, '.pi/agent') });
  if (!reply) throw Error('Normal Pi returned no answer');
  const logs = await p.run('journalctl', ['--user', '-u', 'milo', '-n', '80', '--no-pager', '-o', 'cat']);
  const sources = logs.split('\n').filter(line => line.startsWith('Milo source:'));
  if (!sources.some(line => line.includes('freellmapi answered model milo'))) throw Error('Unexpected source');
  console.log('PASS C:', reply, sources.join('\n'));
  console.log('Services:', await p.ctl('is-active', 'milo', 'milo-router'), 'Backup:', a.backup);
} catch (error) {
  await p.log({ name: 'Original error before rollback', message: error.message, stack: error.stack });
  try {
    if (changed) {
      try { await p.step('Restore normal Pi', () => cp(join(a.backup, 'models'), join(p.home, '.pi/agent/models.json'))); }
      catch (restore) { await p.log({ name: 'Models rollback error', message: restore.message, stack: restore.stack }); }
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
