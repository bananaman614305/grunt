import { spawn } from 'node:child_process'
import { mkdir, open, readFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
export async function proof(stage) {
  const home = '/home/lunchbox'
  const dir = join(home, '.local/state/milo-check')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${stage}-${Date.now()}.log`)
  console.log(path)
  const file = await open(path, 'ax', 0o600)
  const log = async entry => { await file.write(JSON.stringify(entry).replace(/(?:sqr_egress_|sk-|Bearer\s+)[A-Za-z0-9_./+=:-]+/g, '[REDACTED]') + '\n'); await file.sync(); }
  const step = async (name, task) => {
    const start = Date.now()
    await log({ name, start })
    try {
      const out = await task()
      await log({ name, start, end: Date.now(), code: 0,
        stdout: out?.stdout ?? out ?? '', stderr: out?.stderr ?? '' })
      return out
    } catch (err) {
      await log({ name, start, end: Date.now(), code: err.code ?? 1,
        stdout: err.stdout, stderr: err.stderr, message: err.message, stack: err.stack })
      throw err
    }
  }
  let a, units
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
  delete env.MILO_FREELLMAPI_KEY; delete env.MILO_ROUTER_RUNTIME
  const run = (bin, args) => step([bin, ...args].join(' '), () => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', timeout = false
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, 120000)
    child.stdout.on('data', data => out += data)
    child.stderr.on('data', data => err += data)
    child.once('error', e => { clearTimeout(timer); reject(Object.assign(e, { stdout: out, stderr: err })); })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code || signal || timeout) reject(Object.assign(Error(timeout ? 'timeout' : `Exit ${code}`), { code, stdout: out, stderr: err }))
      else resolve({ stdout: out, stderr: err })
    })
  })).then(outcome => outcome.stdout.trim())
  const ctl = (...args) => run('systemctl', ['--user', ...args])
  const marker = process.cwd() + '/.local-proof/marker-a.json'
  const load = () => step('Load A', async () => {
    a = JSON.parse(await readFile(marker, 'utf8'))
    if (a.fingerprint !== 'f1dc32602a96407bb1eecad719dd9a25c7561a12f0488d76110820e8c26c4882') throw Error('Marker A mismatch')
    units = JSON.parse(await readFile(join(a.backup, 'snapshot.json'), 'utf8'))
    return a
  })
  const owns = () => step('Listener', async () => {
    if (await ctl('is-active', 'milo') !== 'active') throw Error('Inactive')
    const pid = await ctl('show', 'milo', '-p', 'MainPID', '--value')
    const lines = await run('ss', ['-ltnp', 'sport = :8788'])
    if (pid === '0' || !lines.split('\n').some(line => line.includes('127.0.0.1:8788') && line.includes(`pid=${pid},`))) throw Error('Wrong listener')
  })
  const rollback = async () => {
    if (!units) throw Error('No snapshot')
    const errors = []
    const attempt = task => task().catch(err => errors.push(err))
    for (const { name, path, present } of units) {
      await attempt(() => ctl('stop', name))
      await attempt(() => ctl('disable', name))
      await attempt(() => step(name, () => present ? cp(join(a.backup, name), path) : rm(path, { force: true })))
    }
    await attempt(() => ctl('daemon-reload'))
    for (const { name, enabled, active } of units) {
      if (enabled === 'enabled') await attempt(() => ctl('enable', name))
      if (active === 'active') await attempt(() => ctl('start', name))
    }
    await attempt(() => ctl('restart', 'milo-pi'))
    await attempt(() => ctl('is-active', 'milo-pi'))
    if (errors.length) throw Error(errors.join('; '))
    console.log('Rollback verified')
  }
  return { home, path, marker, env, log, step, run, ctl, load, owns, rollback,
    close: async () => { await file.close(); console.log(path); } }
}
