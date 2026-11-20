/** Complete caller snapshots stay bounded; no files are silently projected away. */
export const WORKER_SNAPSHOT_TRANSPORT = {
  maxSnapshotBytes: 32 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxRequestBytes: 48 * 1024 * 1024
} as const;
const legacy = { maxSnapshotBytes: 4 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024, maxRequestBytes: 8 * 1024 * 1024 };

/** Older daemons retain their old limits until their capabilities advertise otherwise. */
export function workerSnapshotTransport(value: unknown) {
  if (value === undefined) return { ...legacy };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worker snapshot transport capabilities.');
  const row = value as Record<string, unknown>, keys = Object.keys(WORKER_SNAPSHOT_TRANSPORT) as (keyof typeof WORKER_SNAPSHOT_TRANSPORT)[];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 1)
      || Number(row.maxFileBytes) > Number(row.maxSnapshotBytes) || Number(row.maxRequestBytes) < Number(row.maxSnapshotBytes)) throw new Error('Invalid worker snapshot transport capabilities.');
  return {
    maxSnapshotBytes: Math.min(Number(row.maxSnapshotBytes), WORKER_SNAPSHOT_TRANSPORT.maxSnapshotBytes),
    maxFileBytes: Math.min(Number(row.maxFileBytes), WORKER_SNAPSHOT_TRANSPORT.maxFileBytes),
    maxRequestBytes: Math.min(Number(row.maxRequestBytes), WORKER_SNAPSHOT_TRANSPORT.maxRequestBytes)
  };
}
