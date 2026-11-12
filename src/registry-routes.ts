import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { validateRegistry } from './registry.js';

// Ordinary deployments never publish registry edits. Only the dispatch workflow writes this file.
export function registryRoutes(path = process.env.GRUNT_REGISTRY_FILE ?? '/data/registry.json') {
  const app = new Hono();
  app.get('/v1/registry', async c => {
    try {
      const registry = validateRegistry(JSON.parse(await readFile(path, 'utf8')));
      const body = JSON.stringify(registry);
      const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
      c.header('ETag', etag);
      c.header('Cache-Control', 'public, max-age=0, must-revalidate');
      if (c.req.header('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) return c.body(null, 304);
      c.header('Content-Type', 'application/json');
      return c.body(body);
    } catch { return c.json({ error: 'No valid registry has been published' }, 503); }
  });
  return app;
}
