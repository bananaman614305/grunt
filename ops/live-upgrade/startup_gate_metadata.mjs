// Read-only release API projection. Never imports main.js, constructs providers, or writes state.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const fail = () => { throw new Error('Startup metadata preflight rejected unsafe or changing state.'); };
const digest = value => createHash('sha256').update(value).digest('hex');
async function privateJson(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > limit) fail();
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return { value: JSON.parse(bytes.toString('utf8')), hash: digest(bytes) };
  } finally { await file.close(); }
}
try {
  let inputText = ''; for await (const part of process.stdin) { inputText += part; if (Buffer.byteLength(inputText) > 65536) fail(); }
  const input = JSON.parse(inputText), root = resolve(input.runtimeDirectory), directory = resolve(input.configDirectory);
  const local = name => import(pathToFileURL(join(root, 'dist', 'local', name + '.js')).href);
  const [{ RegistrySync }, { automaticPoolSelection }, sharing, registry, { gruntEnv }] = await Promise.all([
    local('registry'), local('automatic-pool'), local('data-sharing'), import(pathToFileURL(join(root, 'dist', 'registry.js')).href), import(pathToFileURL(join(root, 'dist', 'brand.js')).href)
  ]);
  const env = input.effectiveEnvironment;
  if (!env || typeof env !== 'object' || Array.isArray(env) || resolve(gruntEnv('CONFIG_DIR', env) ?? '') !== directory
    || gruntEnv('BACKGROUND_ACCOUNT_ACQUISITION', env) !== '0' || gruntEnv('SETUP_NO_DATA_SHARING', env) !== '1') fail();
  const sync = new RegistrySync({ directory }); await sync.load(); // load is filesystem-only; never start/sync.
  const curated = sync.current.adapters.filter(a => registry.knownAdapters.has(a.id)).map(a => a.id);
  const configured = gruntEnv('SOURCES', env)?.split(',').map(x => x.trim()).filter(Boolean);
  if (!configured?.length) fail();
  const selection = automaticPoolSelection(directory, configured, curated, gruntEnv('DAEMON', env) === '1');
  const optins = (gruntEnv('OPT_IN_SOURCES', env) ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (optins.some(id => !registry.localOptInAdapterIds.has(id) && id !== 'reflection-beam')) fail();
  const primary = [...new Set([...selection.sources, ...optins])].filter(id => !registry.disabledAdapters.has(id));
  // Exact owner free-pool launcher uses these two explicit opt-ins and curated models.
  const custom = [...new Set([...curated.filter(id => !registry.disabledAdapters.has(id)), 'antseed-vikey', 'reflection-beam'])];
  const eligible = ids => [...new Set(ids.filter(id => !registry.disabledAdapters.has(id)
    && (registry.knownAdapters.has(id) || registry.localOptInAdapterIds.has(id))))].sort();
  const perPort = { '8792': eligible(primary), '8793': eligible(custom) };
  if (input.sourceIdsPerPort !== undefined) {
    if (!input.sourceIdsPerPort || Object.keys(input.sourceIdsPerPort).sort().join(',') !== '8792,8793') fail();
    for (const port of ['8792', '8793']) {
      const ids = input.sourceIdsPerPort[port];
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
        || JSON.stringify(eligible(ids)) !== JSON.stringify(perPort[port])) fail();
    }
  }
  const union = [...new Set(Object.values(perPort).flat())].sort();
  const before = await privateJson(join(directory, 'data-sharing-consent.json'), 65536);
  const receipt = before.value;
  if (receipt.version !== 1 || !receipt.approved || typeof receipt.approved !== 'object' || Array.isArray(receipt.approved)) fail();
  const policies = sharing.DATA_SHARING_POLICIES;
  const validApproval = value => value && typeof value.policy === 'string' && typeof value.approvedAt === 'string' && Number.isFinite(Date.parse(value.approvedAt));
  const current = new Set(policies.filter(p => validApproval(receipt.approved[p.provider])
    && receipt.approved[p.provider].policy === digest(JSON.stringify(p))).map(p => p.provider));
  const staleOrdinary = policies.filter(p => p.approval === undefined && validApproval(receipt.approved[p.provider])
    && receipt.approved[p.provider].policy !== digest(JSON.stringify(p))).map(p => p.provider).sort();
  if (staleOrdinary.length) fail();
  const approved = await sharing.readDataSharingConsent(directory, union);
  if (JSON.stringify([...approved].sort()) !== JSON.stringify(union.filter(id => current.has(id)))) fail();
  const after = await privateJson(join(directory, 'data-sharing-consent.json'), 65536); if (before.hash !== after.hash) fail();
  const blocked = union.filter(id => sharing.requiresDataSharing(id) && !current.has(id));
  const potentialChecks = union.filter(id => !blocked.includes(id));
  const schedule = await privateJson(join(directory, 'maintenance.json'), 65536);
  if (schedule.value.version !== 1 || !schedule.value.entries || typeof schedule.value.entries !== 'object'
    || Array.isArray(schedule.value.entries) || Object.keys(schedule.value.entries).length > 100
    || !Number.isFinite(schedule.value.nextStartAt)) fail();
  const deadlines = Object.fromEntries(potentialChecks.map(id => {
    const value = schedule.value.entries[id]?.nextCheckAt;
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail(); return [id, value];
  }));
  process.stdout.write(JSON.stringify({ version: 1, consentSha256: before.hash,
    policySha256: digest(JSON.stringify(policies)), registrySha256: digest(JSON.stringify(sync.current)),
    retiredPackagedSources: registry.disabledAdapters.has('clixad') && !registry.knownAdapters.has('clixad') ? ['clixad'] : [],
    sourceIdsPerPort: perPort, eligibleUnion: union, consentDeferred: blocked, potentialChecks,
    staleOrdinaryPolicies: staleOrdinary, nextCheckAt: deadlines, maintenanceSha256: schedule.hash,
    probeEntriesSha256: digest(JSON.stringify(potentialChecks.map(id => [id, schedule.value.entries[id]]))),
    primaryManagedAutomatic: selection.automatic, optOut: true, accountAcquisitionDisabled: true }));
} catch { process.stderr.write('Startup metadata preflight failed closed.\n'); process.exitCode = 1; }
