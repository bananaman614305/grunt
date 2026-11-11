import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd(), home = '/home/lunchbox';
const hash = 'f1dc32602a96407bb1eecad719dd9a25c7561a12f0488d76110820e8c26c4882';
const marker = join(root, '.local-proof/marker-a.json');
const models = join(home, '.pi/agent/models.json');
const exec = promisify(execFile);
const proof = root + '/.local-proof';
const tgz = join(proof, 'usemilo-0.4.0.tgz');
if (createHash('sha256').update(await readFile(tgz)).digest('hex') !== hash) throw Error('Hash mismatch');
const id = Date.now(), state = join(home, '.config', `milo-usemilo-final-${id}`);
const bak = join(home, '.local/state', `milo-npx-backup-${id}`);
const piDir = join(proof, `pi-live-${id}`);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
 XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
 MILO_CONFIG_DIR: state, MILO_FREELLMAPI_URL: 'http://127.0.0.1:3003/v1',
 MILO_SETUP_NO_HUMAN: '1', PI_CODING_AGENT_DIR: piDir, MILO_SQUIRE_HOME: home };
delete env.MILO_FREELLMAPI_KEY; delete env.MILO_ROUTER_RUNTIME;
const run = async (bin, args) => (await exec(bin, args, { env, timeout: 120000, maxBuffer: 1048576 })).stdout.trim();
const ctl = (...args) => run('systemctl', ['--user', ...args]);
await mkdir(bak, { recursive: true, mode: 0o700 });
await mkdir(piDir, { recursive: true, mode: 0o700 });
await cp(models, join(bak, 'models'));
await writeFile(join(bak, 'environment'), await ctl('show', 'milo-pi', '-p', 'Environment', '--value'), { mode: 0o600 });
const units = [];
for (const name of ['milo-pi', 'milo', 'milo-router']) {
 const path = join(home, '.config/systemd/user', `${name}.service`);
 const active = await ctl('is-active', name).catch(() => 'inactive');
 const enabled = await ctl('is-enabled', name).catch(() => 'disabled');
 let exists = true;
 try { await cp(path, join(bak, name)); }
 catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
 units.push({ name, path, active, enabled, present: exists });
}
await writeFile(join(bak, 'snapshot.json'), JSON.stringify(units), { mode: 0o600 });
let out = '', picked = false;
try {
 await ctl('stop', 'milo-pi'); await ctl('disable', 'milo-pi');
 const p = spawn('script', ['-q', '-e', '-c', `stty cols 100 rows 40 && exec npx --yes --package ${tgz} milo setup`, '/dev/null'], { cwd: root, env });
 const log = chunk => {
 out += chunk.toString();
 if (!picked && out.includes('Choose your providers')) { picked = true; p.stdin.write('\r'); }
 };
 p.stdout.on('data', log); p.stderr.on('data', log);
 const timer = setTimeout(() => p.kill('SIGTERM'), 540000);
 const code = await new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', resolve); });
 clearTimeout(timer);
 const clean = out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
 await writeFile(join(proof, 'live-a.txt'), clean, { mode: 0o600 });
 if (code || !clean.includes('Milo is ready')) throw Error('Wizard failed');
 await ctl('restart', 'milo'); await ctl('restart', 'milo-pi');
 console.log(await ctl('is-active', 'milo', 'milo-pi'));
 await writeFile(marker, JSON.stringify({ backup: bak, fingerprint: hash, state, piDir }), { mode: 0o600 });
 console.log('PASS A', bak);
} catch (error) {
 for (const u of units) {
 for (const op of ['stop', 'disable']) await ctl(op, u.name).catch(() => {});
 if (u.present) await cp(join(bak, u.name), u.path);
 else await rm(u.path, { force: true });
 }
 await cp(join(bak, 'models'), models);
 await ctl('daemon-reload');
 for (const u of units) {
  if (u.enabled === 'enabled') await ctl('enable', u.name);
  if (u.active === 'active') await ctl('start', u.name);
 }
 await ctl('restart', 'milo-pi');
 console.log('Restored:', await ctl('is-active', 'milo-pi'), bak);
 process.exitCode = 1; console.log(error.message);
}
