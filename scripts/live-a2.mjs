import { readFile, writeFile, rm, stat, mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
const helper = new URL('./live-lib.mjs', import.meta.url)
if (createHash('sha256').update(await readFile(helper)).digest('hex') !== '4d8e6b2e1c0601e3adc6a2cb6880d92c0bb9889ea773efc3156620510058e0b5') throw Error('Helper hash mismatch')
const { proof } = await import(helper.href)
const p = await proof('stage-a2')
let changed = false, wizard, router
try {
  const a = await p.load()
  await p.step('Validate reusable setup', async () => {
    const packed = await readFile('.local-proof/usemilo-0.4.0.tgz')
    if (createHash('sha256').update(packed).digest('hex') !== a.fingerprint) throw Error('Package hash mismatch')
    const dir = await mkdtemp('.local-proof/wizard-')
    await p.run('tar', ['-xzf', '.local-proof/usemilo-0.4.0.tgz', '-C', dir])
    const deps = '.local-proof/usemilo-deps.tgz'
    if (createHash('sha256').update(await readFile(deps)).digest('hex') !== '402cc3ffbcda711396335e55f21d00f1f1c133822819d5b93189f7ff37c8e657') throw Error('Dependency hash mismatch')
    await p.run('tar', ['-xzf', deps, '-C', join(dir, 'package')])
    wizard = await import(pathToFileURL(resolve(dir, 'package/dist/local/wizard.js')).href)
    router = await import(pathToFileURL(resolve(dir, 'package/dist/local/native-router.js')).href)
    if (a.state !== join(p.home, '.config/milo-usemilo-final-1794367590480')) throw Error('Unexpected state')
    for (const file of ['runtime/dist/local/main.js', 'freellmapi/runner.mjs', 'freellmapi/source/server/dist/index.js', 'freellmapi/' + router.FREELLMAPI_REVISION]) await stat(join(a.state, file))
    const units = JSON.parse(await readFile(join(a.backup, 'snapshot.json'), 'utf8'))
    for (const unit of units) {
      if (!unit.present || !(await readFile(unit.path)).equals(await readFile(join(a.backup, unit.name)))) throw Error('Baseline unit changed')
    }
  })
  await p.log({ name: 'Service PATH', PATH: p.env.PATH })
  await p.run('/bin/sh', ['-c', 'command -v node && command -v opencode'])
  changed = true
  await p.ctl('stop', 'milo-pi')
  await p.ctl('disable', 'milo-pi')
  await p.ctl('stop', 'milo')
  await p.ctl('stop', 'milo-router')
  await p.ctl('reset-failed', 'milo')
  const old = { ...process.env }
  Object.assign(process.env, p.env, { MILO_CONFIG_DIR: a.state, MILO_FREELLMAPI_URL: 'http://127.0.0.1:3003/v1', MILO_PORT: '8788' })
  try {
    await p.step('Package router installer', router.ensureNativeRouter)
    await p.step('Package Milo installer', wizard.installService)
  } finally {
    process.env = old
  }
  await p.step('Wait 15 seconds', () => new Promise(resolve => setTimeout(resolve, 15000)))
  await p.owns()
  if (await p.ctl('is-active', 'milo-router') !== 'active') throw Error('Router inactive')
  await p.step('Fresh marker A', async () => {
    await rm('.local-proof/marker-b.json', { force: true })
    await writeFile(p.marker, JSON.stringify({ ...a, appliedAt: new Date().toISOString() }), { mode: 0o600 })
  })
  console.log('PASS A2', a.backup)
} catch (error) {
  await p.log({ name: 'Error before rollback', message: error.message, stack: error.stack })
  try {
    if (changed) await p.rollback()
  } catch (rollback) {
    await p.log({ name: 'Rollback error', message: rollback.message, stack: rollback.stack })
  } finally {
    await p.log({ name: 'Error after rollback', message: error.message, stack: error.stack })
    console.error(error.message.replace(/(?:sqr_egress_|sk-)\S+/g, '[REDACTED]'))
    process.exitCode = 1
  }
} finally { await p.close(); }
