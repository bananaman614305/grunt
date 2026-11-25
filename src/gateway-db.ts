import { createClient } from '@libsql/client';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function defaultGatewayDb(directory = '/data') {
  const current = join(directory, 'grunt.db'), legacy = join(directory, 'milo.db');
  return `file:${!existsSync(current) && existsSync(legacy) ? legacy : current}`;
}

export async function openGatewayDb(url: string) {
  if (url.startsWith('file:') && url !== 'file::memory:') mkdirSync(dirname(url.slice(5)), { recursive: true });
  const db = createClient({ url: url === ':memory:' ? 'file::memory:' : url });
  await db.execute('PRAGMA journal_mode=WAL');
  return db;
}
