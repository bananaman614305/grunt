import { expect, it } from 'vitest';
import { WORKER_SNAPSHOT_TRANSPORT, workerSnapshotTransport } from './worker-transport.js';

it('negotiates bounded transport and preserves legacy daemon limits', () => {
  expect(workerSnapshotTransport(undefined)).toEqual({ maxSnapshotBytes: 4 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024, maxRequestBytes: 8 * 1024 * 1024 });
  expect(workerSnapshotTransport(WORKER_SNAPSHOT_TRANSPORT)).toEqual(WORKER_SNAPSHOT_TRANSPORT);
  expect(workerSnapshotTransport({ maxSnapshotBytes: 64 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, maxRequestBytes: 96 * 1024 * 1024 })).toEqual(WORKER_SNAPSHOT_TRANSPORT);
  expect(workerSnapshotTransport({ maxSnapshotBytes: 1024, maxFileBytes: 512, maxRequestBytes: 2048 })).toEqual({ maxSnapshotBytes: 1024, maxFileBytes: 512, maxRequestBytes: 2048 });
});

it.each([null, [], {}, { ...WORKER_SNAPSHOT_TRANSPORT, extra: true }, { ...WORKER_SNAPSHOT_TRANSPORT, maxFileBytes: 0 },
  { ...WORKER_SNAPSHOT_TRANSPORT, maxFileBytes: 0.5 }, { ...WORKER_SNAPSHOT_TRANSPORT, maxRequestBytes: Number.MAX_SAFE_INTEGER + 1 },
  { ...WORKER_SNAPSHOT_TRANSPORT, maxFileBytes: WORKER_SNAPSHOT_TRANSPORT.maxSnapshotBytes + 1 },
  { ...WORKER_SNAPSHOT_TRANSPORT, maxRequestBytes: WORKER_SNAPSHOT_TRANSPORT.maxSnapshotBytes - 1 }])('rejects malformed advertised bounds: %j', value => {
  expect(() => workerSnapshotTransport(value)).toThrow('Invalid worker snapshot transport');
});
