#!/usr/bin/env node
// Contract between the Amazing Adventure runner and the Grunt runtime it uses.
//   node check_runtime_contract.mjs <root> [--import] [--list]
// <root> is an installed runtime (has dist/) or a Grunt checkout (has src/). Prints the transitive local-module closure of each
// entry point the runner relies on and exits 1 if (a) a required module/export is missing, or (b) a closure contains a module of a
// feature that is being removed (subworkers, background jobs, execution checkpoints). --import also loads the modules (dist only).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.'), doImport = process.argv.includes('--import');
const base = existsSync(join(root, 'dist/local')) ? join(root, 'dist') : join(root, 'src');
const ext = base.endsWith('dist') ? '.js' : '.ts';

// What the runner needs: module (relative to dist/ or src/, without extension) -> named exports.
export const REQUIRED = {
  // free-pool.mjs (the 8793 pool launcher)
  'local/main': ['configure'],
  'local/api': ['createLocalApp'],
  'local/diagnostics': ['DiagnosticsStore'],
  'local/registry': ['RegistrySync'],
  'local/runtime-maintenance': ['createSourceMaintenance'],
  'local/runtime-routing': ['createRuntimeRoutingHistory'],
  'registry': ['knownAdapters', 'disabledAdapters'],
  // grunt-release (worker-side client) and the execution host service
  'local/efficiency-host': ['loadExecutionHostChannels', 'loadExecutionHostPolicy', 'openExecutionHost', 'executionHostCommand', 'createPublicationFileChannel'],
};
// Entry points whose closure must stay free of removed features.
const ENTRIES = ['local/efficiency-host', 'local/main', 'local/api', 'local/runtime-routing', 'local/runtime-maintenance', 'local/diagnostics', 'local/registry'];
const FORBIDDEN = /(^|\/)(worker-[a-z-]+|jobs(-[a-z]+)?|execution-checkpoint(-pi)?|coordination-store|worker-pi)$/;

const file = (module) => join(base, module + ext);
const imports = (module) => {
  let text;
  try { text = readFileSync(file(module), 'utf8'); } catch { return null; }
  const found = new Set();
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+?)(?:\.js|\.ts)?['"]/g)) found.add(m[1]);
  return [...found].map((spec) => relative(base, resolve(dirname(file(module)), spec)).split('\\').join('/'));
};
let failed = false;
const report = (line) => console.log(line);
for (const entry of ENTRIES) {
  const seen = new Map(), queue = [entry];
  while (queue.length) {
    const module = queue.shift();
    if (seen.has(module)) continue;
    const deps = imports(module);
    seen.set(module, deps);
    for (const dep of deps ?? []) if (!dep.startsWith('..')) queue.push(dep);
  }
  const missing = [...seen].filter(([, deps]) => deps === null).map(([m]) => m);
  const forbidden = [...seen.keys()].filter((m) => FORBIDDEN.test(m));
  report(`entry ${entry}: closure ${seen.size} modules` + (missing.length ? `; unresolved ${missing.join(',')}` : '') + (forbidden.length ? `; FORBIDDEN ${forbidden.join(',')}` : '; clean'));
  if (process.argv.includes('--list') || entry === 'local/efficiency-host') report('  ' + entry + ' closure: ' + [...seen.keys()].sort().join(' '));
  if (forbidden.length || missing.length) failed = true;
}
for (const [module, names] of Object.entries(REQUIRED)) {
  if (!existsSync(file(module))) { report(`MISSING module ${module}`); failed = true; continue; }
  const text = readFileSync(file(module), 'utf8');
  for (const name of names) if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(text)) { report(`MISSING export ${name} in ${module}`); failed = true; }
}
if (doImport) {
  if (ext !== '.js') { report('--import needs an installed runtime (dist/)'); process.exit(2); }
  for (const [module, names] of Object.entries(REQUIRED)) {
    const loaded = await import(pathToFileURL(file(module)).href);
    for (const name of names) if (!(name in loaded)) { report(`IMPORT MISSING ${name} in ${module}`); failed = true; }
  }
  const hono = join(root, 'node_modules/@hono/node-server/dist/index.mjs');
  if (!existsSync(hono) || typeof (await import(pathToFileURL(hono).href)).serve !== 'function') { report('MISSING @hono/node-server serve'); failed = true; }
  // grunt-release's use of the channel client: the shape it calls.
  const { loadExecutionHostChannels } = await import(pathToFileURL(file('local/efficiency-host')).href);
  const { mkdtempSync, writeFileSync, mkdirSync, realpathSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'contract-')));
  mkdirSync(join(dir, 'project'), { mode: 0o700 }); mkdirSync(join(dir, 'channels'), { mode: 0o700 });
  writeFileSync(join(dir, 'channel.json'), JSON.stringify({ version: 1, projectRoot: join(dir, 'project'), channelDirectory: join(dir, 'channels') }), { mode: 0o600 });
  const channels = await loadExecutionHostChannels(join(dir, 'channel.json'));
  for (const [object, methods] of [['verificationBroker', ['start', 'status', 'result']], ['publicationChannel', ['request']]])
    for (const method of methods) if (typeof channels?.[object]?.[method] !== 'function') { report(`CHANNEL SHAPE missing ${object}.${method}`); failed = true; }
}
report(failed ? 'CONTRACT FAILED' : 'CONTRACT OK');
process.exit(failed ? 1 : 0);
