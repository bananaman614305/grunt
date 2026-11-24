// Bring the live registry cache to a pinned public publication with the installed runtime's own RegistrySync: the same fetch-result
// validator (validateRegistry), the same acceptance rule (only a newer publication, or the identical one), the same canonical
// `{registry, etag}` shape and the same atomic temp-file-and-rename write the daemon's six-hourly refresh performs. Only the fetcher
// differs: it returns the pinned bytes instead of calling the network. No provider, port or unit is touched.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fail = reason => { process.stderr.write(`Registry cache refresh refused: ${reason}\n`); process.exit(1); };
let input = '';
for await (const part of process.stdin) { input += part; if (Buffer.byteLength(input) > 8 * 1024 * 1024) fail('input too large'); }
let request;
try { request = JSON.parse(input); } catch { fail('input is not JSON'); }
const { runtime, directory, registry, etag } = request;
if (typeof runtime !== 'string' || resolve(runtime) !== runtime || typeof directory !== 'string' || resolve(directory) !== directory) fail('absolute runtime and directory required');
if (typeof registry !== 'string' || !registry) fail('registry bytes required');
if (etag !== null && (typeof etag !== 'string' || etag.length > 4096 || /[\x00-\x1f\x7f]/.test(etag))) fail('invalid etag');
const { RegistrySync } = await import(pathToFileURL(join(runtime, 'dist/local/registry.js')).href);
const messages = [];
const sync = new RegistrySync({
  directory, url: 'https://pinned-public-registry.invalid/v1/registry', notify: text => messages.push(text),
  fetcher: async () => new Response(registry, { status: 200, headers: etag === null ? {} : { ETag: etag } })
});
let previous;
try {
  await sync.load();
  previous = sync.current.published;
  await sync.sync();
} finally { await sync.close(); }
if (messages.length) fail('the installed runtime rejected the pinned registry (not newer than the cache, invalid, or not writable)');
const written = await readFile(join(directory, 'registry.json'), 'utf8');
const canonical = JSON.stringify({ registry: sync.current, ...(etag === null ? {} : { etag }) });
if (written !== canonical) fail('the cache is not the canonical writer shape after the refresh');
process.stdout.write(JSON.stringify({ published: sync.current.published, previousPublished: previous, rawBytes: Buffer.byteLength(written), rawSha256: createHash('sha256').update(written).digest('hex') }));
