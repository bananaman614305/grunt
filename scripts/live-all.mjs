import { readFile, writeFile, cp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const pins = {
  lib: '4d8e6b2e1c0601e3adc6a2cb6880d92c0bb9889ea773efc3156620510058e0b5',
  a2: '9d1a093be86be0132fd5a963a27fae51e26fd3908ffa4b2817935c77fd94d7b9',
  b: '7decbaef17f8c6a8d448484847b32037feb2e43eb47ca33d857eecc4039ecd65',
  c: '31085a48cce0cda7be80e7b81408ae02799589eafeb58bf186426bb8cd2d29eb',
}
for (const [name, hash] of Object.entries(pins)) {
  const bytes = await readFile(new URL(`./live-${name}.mjs`, import.meta.url))
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error(`Hash mismatch: ${name}`)
}
const { proof } = await import('./live-lib.mjs')
const p = await proof('stage-all')
const models = join(p.home, '.pi/agent/models.json'), backup = p.path + '.models.json'
let changed = false, saved = false
const stage = name => p.step(`Stage ${name}`, async () => {
  await import(new URL(`./live-${name}.mjs`, import.meta.url).href)
  if (process.exitCode) throw Error(`Stage ${name} failed`)
  return `PASS ${name.toUpperCase()}`
})
try {
  const a = await p.load()
  changed = true
  await stage('a2')
  await p.ctl('restart', 'milo')
  await p.step('Wait for Milo listener', async () => {
    const deadline = Date.now() + 30000
    for (;;) {
      try { await p.owns(); return }
      catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  })
  await stage('b')
  await p.step('Gate B', async () => {
    const current = JSON.parse(await readFile(p.marker, 'utf8'))
    const b = JSON.parse(await readFile('.local-proof/marker-b.json', 'utf8'))
    if (b.marker !== p.marker || JSON.stringify(b.a) !== JSON.stringify(current)) throw Error('Marker B mismatch')
  })
  await p.step('Snapshot before C', async () => {
    await writeFile(backup, await readFile(models), { mode: 0o600, flag: 'wx' })
    saved = true
  })
  await stage('c')
  await p.owns()
  console.log('PASS ALL', 'Backup:', a.backup, 'Pi snapshot:', backup)
} catch (error) {
  await p.log({ name: 'Error before rollback', message: error.message, stack: error.stack })
  if (saved) {
    try { await p.step('Restore pre-C Pi', () => cp(backup, models)) }
    catch (rollback) { await p.log({ name: 'Models rollback error', message: rollback.message, stack: rollback.stack }) }
  }
  try {
    if (changed) {
      await p.step('Invalidate B', () => rm('.local-proof/marker-b.json', { force: true }))
      await p.rollback()
    }
  } catch (rollback) {
    await p.log({ name: 'Rollback error', message: rollback.message, stack: rollback.stack })
  } finally {
    await p.log({ name: 'Error after rollback', message: error.message, stack: error.stack })
    process.exitCode = 1
  }
} finally { await p.close() }
