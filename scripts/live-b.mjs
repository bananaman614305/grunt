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
try {
  const reply = await run('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply exactly: Milo is ready']);
  if (!reply) throw new Error('Pi returned no answer');
  const logs = await run('journalctl', ['--user', '-u', 'milo', '-n', '80', '--no-pager', '-o', 'cat']);
  const safeLogs = logs.split('\n').filter(line => line.startsWith('Milo source:'));
  if (!safeLogs.some(line => line.includes('freellmapi answered model milo'))) throw new Error('Pi used an unexpected source');
  const dbPath = join(state, 'freellmapi/router.db');
  if (((await stat(dbPath)).mode & 0o777) !== 0o600) throw new Error('Router DB is not private');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const admin = JSON.parse(await readFile(join(state, 'router-admin.json'), 'utf8'));
  const keys = db.prepare('SELECT platform,label,base_url,encrypted_key,iv,auth_tag FROM api_keys').all();
  if (keys.length !== 1) throw new Error('Unexpected provider entries');
  for (const key of keys) {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(admin.encryption, 'hex'), Buffer.from(key.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(key.auth_tag, 'hex'));
    const token = decipher.update(key.encrypted_key, 'hex', 'utf8') + decipher.final('utf8');
    if (!token.startsWith('sqr_egress_') || key.platform !== 'custom') throw new Error('Router holds an unexpected credential type');
  }
  const attempts = db.prepare("SELECT model_id,outcome,key_label FROM request_attempts ORDER BY id DESC LIMIT 4").all();
  db.close();
  await writeFile(join(root, '.local-proof/marker-b.json'), JSON.stringify({ marker, a }), { mode: 0o600 });
  console.log('PASS B:', reply, safeLogs.join('\n'), JSON.stringify(attempts));
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
