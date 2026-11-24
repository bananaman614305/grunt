// Read-only validation of normal RegistrySync cache output; no sync/provider construction.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const fail = () => { throw Error('Derived registry cache rejected'); };
const sha = body => createHash('sha256').update(body).digest('hex');
try {
  let input = ''; for await (const part of process.stdin) { input += part; if (Buffer.byteLength(input) > 16384) fail(); }
  const value = JSON.parse(input), path = resolve(value.path);
  if (path !== value.path || !/^[a-f0-9]{64}$/.test(value.expectedCatalogSha256)) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > 131072) fail();
    raw = await file.readFile(); const after = await file.stat();
    if (raw.length > 131072 || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
  } finally { await file.close(); }
  const saved = JSON.parse(raw.toString('utf8'));
  const { validateRegistry } = await import(pathToFileURL(join(resolve(value.candidateRuntime), 'dist/registry.js')).href);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Object.hasOwn(saved, 'registry')
    || Object.keys(saved).some(key => !['registry', 'etag'].includes(key))
    || Object.hasOwn(saved, 'etag') && (typeof saved.etag !== 'string' || saved.etag.length > 4096 || /[\x00-\x1f\x7f]/.test(saved.etag))) fail();
  const registry = validateRegistry(saved.registry), canonical = JSON.stringify({ registry, ...(Object.hasOwn(saved, 'etag') ? { etag: saved.etag } : {}) });
  const catalogSha256 = sha(JSON.stringify(registry));
  if (catalogSha256 !== value.expectedCatalogSha256 || raw.toString('utf8') !== canonical) fail();
  process.stdout.write(JSON.stringify({ rawSha256: sha(raw), catalogSha256, normalWriterShape: true }));
} catch { process.stderr.write('Derived registry cache proof failed closed.\n'); process.exitCode = 1; }
