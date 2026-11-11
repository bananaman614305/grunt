import { spawn } from 'node:child_process';
import { mkdir, open, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
export async function proof(stage) {
  const home = '/home/lunchbox';
  const dir = join(home, '.local/state/milo-check');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${stage}-${new Date().toISOString().replaceAll(':', '-')}.log`);
  console.log(path);
  const file = await open(path, 'ax', 0o600);
  const log = async entry => { await file.write(JSON.stringify(entry).replace(/(?:sqr_egress_|sk-|Bearer\s+)[A-Za-z0-9_./+=:-]+/g, '[REDACTED]') + '\n'); await file.sync(); };
  const step = async (name, action) => {
    const start = new Date().toISOString();
    await log({ name, start });
    try {
      const out = await action();
      await log({ name, start, end: new Date().toISOString(), code: 0,
        stdout: out?.stdout ?? out ?? '', stderr: out?.stderr ?? '' });
      return out;
    } catch (error) {
      await log({ name, start, end: new Date().toISOString(), code: error.code ?? 1,
        stdout: error.stdout, stderr: error.stderr, message: error.message, stack: error.stack });
      throw error;
    }
  };
  let a, units;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  delete env.MILO_FREELLMAPI_KEY; delete env.MILO_ROUTER_RUNTIME;
  const run = (bin, args, extra = {}) => step([bin, ...args].join(' '), () => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, 120000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(Object.assign(error, { stdout, stderr })); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code || signal || timeout) reject(Object.assign(Error(timeout ? '120000ms timeout' : `Exit ${code}/${signal}`), { code, stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  })).then(result => result.stdout.trim());
  const ctl = (...args) => run('systemctl', ['--user', ...args]);
  const marker = join(process.cwd(), '.local-proof/marker-a.json');
  const load = () => step('Load A', async () => {
    a = JSON.parse(await readFile(marker, 'utf8'));
    if (a.fingerprint !== 'f1dc32602a96407bb1eecad719dd9a25c7561a12f0488d76110820e8c26c4882') throw Error('Marker A mismatch');
    units = JSON.parse(await readFile(join(a.backup, 'snapshot.json'), 'utf8'));
    return a;
  });
  const owns = () => step('Listener', async () => {
    if (await ctl('is-active', 'milo') !== 'active') throw Error('Inactive');
    const pid = await ctl('show', 'milo', '-p', 'MainPID', '--value');
    const lines = await run('ss', ['-ltnp', 'sport = :8788']);
    if (pid === '0' || !lines.split('\n').some(line => line.includes('127.0.0.1:8788') && line.includes(`pid=${pid},`))) throw Error('Wrong listener');
  });
  const rollback = async () => {
    if (!units) throw Error('No snapshot');
    for (const saved of units) {
      await ctl('stop', saved.name).catch(() => {});
      await ctl('disable', saved.name).catch(() => {});
      await step(saved.name, () => saved.present ? cp(join(a.backup, saved.name), saved.path) : rm(saved.path, { force: true }));
    }
    await ctl('daemon-reload');
    for (const saved of units) {
      if (saved.enabled === 'enabled') await ctl('enable', saved.name);
      if (saved.active === 'active') await ctl('start', saved.name);
    }
    await ctl('restart', 'milo-pi');
    console.log('Rollback verified:', await ctl('is-active', 'milo-pi'));
  };
  return { home, marker, env, log, step, run, ctl, load, owns, rollback,
    close: async () => { await file.close(); console.log(path); } };
}
