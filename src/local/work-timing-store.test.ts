import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DiagnosticsStore } from './diagnostics.js';
import { runtimeWorkTiming } from './work-timing-store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-timing-store-')); directories.push(path); return path; }

test('unused timing creates no storage; close is idempotent', async () => {
  const root = await directory(), path = join(root, 'unused'); const recorder = runtimeWorkTiming(path);
  await recorder.close(); await recorder.close(); await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('close flushes queued starts and finishes into private durable storage', async () => {
  const path = await directory(), recorder = runtimeWorkTiming(path), parentId = randomUUID();
  recorder.timing.start('tool', { parentId }).finish('passed');
  await recorder.close();
  const store = await DiagnosticsStore.open({ directory: path });
  try {
    const result = await store.list({ limit: 50 });
    const events = result.events.filter(event => event.type.startsWith('work.'));
    expect(events.map(event => event.type)).toEqual(['work.start', 'work.finish']);
    expect(events.every(event => event.parentId === parentId && event.actor === 'worker')).toBe(true);
    expect((await store.metrics()).buckets.some(bucket => bucket.dimensions.stage === 'tool')).toBe(true);
    expect((await stat(join(path, 'diagnostics.db'))).mode & 0o777).toBe(0o600);
  } finally { await store.close(); }
});

test('unsafe or unavailable observation cannot fail measured work', async () => {
  const root = await directory(); await writeFile(join(root, 'file'), '');
  const recorder = runtimeWorkTiming(join(root, 'file', 'metrics'));
  const span = recorder.timing.start('checkpoint');
  expect(span.run(() => 42)).toBe(42); expect(() => span.finish('passed')).not.toThrow(); await recorder.close();
});

test('bounded lazy buffering reports dropped observations in durable coverage', async () => {
  const path = await directory(), recorder = runtimeWorkTiming(path);
  for (let index = 0; index < 600; index++) recorder.timing.start('tool').finish('passed');
  expect(recorder.health().droppedEvents).toBe(200);
  await recorder.close();
  const store = await DiagnosticsStore.open({ directory: path });
  try { expect((await store.metrics()).coverage.droppedEvents).toBeGreaterThanOrEqual(200); }
  finally { await store.close(); }
});
