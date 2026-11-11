import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const root = process.cwd(), home = '/home/lunchbox';
const fingerprint = 'f1dc32602a96407bb1eecad719dd9a25c7561a12f0488d76110820e8c26c4882';
const marker = join(root, '.local-proof/marker-a.json');
const models = join(home, '.pi/agent/models.json');
const exec = promisify(execFile);
const a = JSON.parse(await readFile(marker, 'utf8'));
if (a.fingerprint !== fingerprint) throw Error('Marker A fingerprint mismatch');
const { backup, state, piDir } = a;
const snapshots = JSON.parse(await readFile(join(backup, 'snapshot.json'), 'utf8'));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  MILO_CONFIG_DIR: state, MILO_FREELLMAPI_URL: 'http://127.0.0.1:3003/v1',
  MILO_SETUP_NO_HUMAN: '1', PI_CODING_AGENT_DIR: piDir, MILO_SQUIRE_HOME: home };
delete env.MILO_FREELLMAPI_KEY; delete env.MILO_ROUTER_RUNTIME;
const run = async (bin, args, customEnv = env) => (await exec(bin, args, { env: customEnv, timeout: 120000, maxBuffer: 1048576 })).stdout.trim();
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const b = JSON.parse(await readFile(join(root, '.local-proof/marker-b.json'), 'utf8'));
if (b.marker !== marker || JSON.stringify(b.a) !== JSON.stringify(a)) throw Error('Marker B mismatch');
try {
  const { configurePi } = await import('../dist/local/wizard.js');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
  try { await configurePi(); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const reply = await run('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply exactly: Milo is ready'], { ...env, PI_CODING_AGENT_DIR: join(home, '.pi/agent') });
  if (!reply) throw Error('Normal Pi returned no answer');
  const logs = await run('journalctl', ['--user', '-u', 'milo', '-n', '80', '--no-pager', '-o', 'cat']);
  const sources = logs.split('\n').filter(line => line.startsWith('Milo source:'));
  if (!sources.some(line => line.includes('freellmapi answered model milo'))) throw Error('Unexpected source');
  console.log('PASS C:', reply, sources.join('\n'));
  console.log('Services:', await ctl('is-active', 'milo', 'milo-pi'), 'Backup:', backup);
} catch (error) {
  for (const saved of snapshots) {
    await ctl('stop', saved.name).catch(() => {});
    await ctl('disable', saved.name).catch(() => {});
    if (saved.present) await cp(join(backup, saved.name), saved.path);
    else await rm(saved.path, { force: true });
  }
  await cp(join(backup, 'models'), models);
  await ctl('daemon-reload');
  for (const saved of snapshots) {
    if (saved.enabled === 'enabled') await ctl('enable', saved.name);
    if (saved.active === 'active') await ctl('start', saved.name);
  }
  await ctl('restart', 'milo-pi');
  console.log('Rollback verified:', await ctl('is-active', 'milo-pi'), backup);
  process.exitCode = 1; console.log(error.message);
}
