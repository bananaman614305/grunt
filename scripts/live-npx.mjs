// Authorized live setup with a packed, unpublished usemilo build and rollback.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const root = process.cwd(), home = '/home/lunchbox', id = Date.now();
const packedHash = createHash('sha256').update(await readFile(join(root, '.local-proof/usemilo-0.4.0.tgz'))).digest('hex');
if (packedHash !== 'f1dc32602a96407bb1eecad719dd9a25c7561a12f0488d76110820e8c26c4882') throw new Error('Packed artifact changed; request a new approval');
const state = join(home, '.config', `milo-usemilo-final-${id}`);
const backup = join(home, '.local/state', `milo-npx-backup-${id}`);
const piDir = join(root, '.local-proof', `pi-live-${id}`);
const models = join(home, '.pi/agent/models.json');
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  MILO_CONFIG_DIR: state, MILO_FREELLMAPI_URL: 'http://127.0.0.1:3003/v1',
  MILO_SETUP_NO_HUMAN: '1', PI_CODING_AGENT_DIR: piDir, MILO_SQUIRE_HOME: home };
delete env.MILO_FREELLMAPI_KEY; delete env.MILO_ROUTER_RUNTIME;
const exec = promisify(execFile);
const run = async (binary, args, customEnv = env) => (await exec(binary, args, { env: customEnv, timeout: 120000, maxBuffer: 1048576 })).stdout.trim();
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const unit = join(home, '.config/systemd/user/milo-pi.service');
await mkdir(backup, { recursive: true, mode: 0o700 });
await mkdir(piDir, { recursive: true, mode: 0o700 });
await cp(unit, join(backup, 'unit'));
await cp(models, join(backup, 'models'));
await writeFile(join(backup, 'environment'), await ctl('show', 'milo-pi', '-p', 'Environment', '--value'), { mode: 0o600 });
console.log('Backed up old unit, environment and normal Pi config. Fresh Milo state and isolated Pi profile selected.');
const serviceSnapshots = [];
for (const name of ['milo', 'milo-router']) {
  const path = join(home, '.config/systemd/user', `${name}.service`);
  const active = await ctl('is-active', name).catch(() => 'inactive');
  const enabled = await ctl('is-enabled', name).catch(() => 'disabled');
  let present = true;
  try { await cp(path, join(backup, `${name}.service`)); }
  catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
  serviceSnapshots.push({ name, path, active, enabled, present });
}
let output = '', frames = [], started = Date.now();
try {
  await ctl('stop', 'milo-pi'); await ctl('disable', 'milo-pi');
  const packed = join(root, '.local-proof/usemilo-0.4.0.tgz');
  const child = spawn('script', ['-q', '-e', '-c', `stty cols 100 rows 40 && exec npx --yes --package ${packed} milo setup`, '/dev/null'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let picked = false;
  const collect = chunk => {
    const text = chunk.toString(); output += text; frames.push([(Date.now() - started) / 1000, 'o', text]);
    if (!picked && output.includes('Choose your providers')) { picked = true; setTimeout(() => child.stdin.write('\r'), 200); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timeout = setTimeout(() => child.kill('SIGTERM'), 540000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timeout);
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  await writeFile(join(root, '.local-proof/live-npx-transcript.txt'), clean, { mode: 0o600 });
  await writeFile(join(root, '.local-proof/live-npx-rail.cast'), [JSON.stringify({ version: 2, width: 100, height: 40, timestamp: Math.floor(started / 1000), title: 'Live usemilo setup — squire, Groq egress grant' }), ...frames.map(frame => JSON.stringify(frame))].join('\n') + '\n', { mode: 0o600 });
  if (code !== 0 || !clean.includes('Milo is ready')) throw new Error('Packed wizard did not finish: ' + clean.split(/[\r\n]/).filter(Boolean).at(-1));
  await ctl('restart', 'milo');
  await new Promise(resolve => setTimeout(resolve, 2000));
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
  // Merge the verified provider into the user's ordinary Pi config too.
  const { configurePi } = await import('../dist/local/wizard.js');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
  await configurePi();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  const report = `PASS: packed usemilo 0.4.0 wizard printed Milo is ready and exited.\nRestarted milo; real Pi (isolated profile) replied: ${reply}\n${safeLogs.join('\n')}\nFreeLLMAPI holds only one encrypted Squire egress grant, database mode 0600.\nRouter attempts: ${JSON.stringify(attempts)}\nNormal Pi models config updated; prior settings backed up.\n`;
  await writeFile(join(root, '.local-proof/live-npx-result.txt'), report, { mode: 0o600 });
  console.log(report);
} catch (error) {
  for (const saved of serviceSnapshots) {
    await ctl('stop', saved.name).catch(() => {});
    await ctl('disable', saved.name).catch(() => {});
    if (saved.present) await cp(join(backup, `${saved.name}.service`), saved.path);
    else await rm(saved.path, { force: true });
  }
  await ctl('daemon-reload');
  for (const saved of serviceSnapshots) {
    if (saved.enabled === 'enabled') await ctl('enable', saved.name);
    if (saved.active === 'active') await ctl('start', saved.name);
  }
  await cp(join(backup, 'unit'), unit); await cp(join(backup, 'models'), models);
  await ctl('daemon-reload'); await ctl('enable', 'milo-pi'); await ctl('restart', 'milo-pi');
  console.log('Restored old service and ordinary Pi config.'); console.log(error.message); process.exitCode = 1;
}

