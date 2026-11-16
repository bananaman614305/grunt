import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function daemon(body: unknown, status = 200) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  return { port: address.port, paths };
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  // If the status branch accidentally falls through to daemon startup, an
  // invalid source selection fails instead of signing up or claiming a port.
  return execute(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, NO_COLOR: '1', MILO_SOURCES: 'synthetic-never-start', ...env }, timeout: 15000,
  });
}

it('runs the real CLI status entry point without starting setup or probing models', async () => {
  const snapshot = { version: 1, updatedAt: Date.now(), activeRequests: 0,
    sources: [{ id: 'perch', state: 'ready', active: 0, model: 'deepseek-flash-starter', lastReplyMs: 1234 }] };
  const { port, paths } = await daemon(snapshot);
  const { stdout, stderr } = await cli(['status', '--port', String(port), '--json']);
  expect(JSON.parse(stdout)).toMatchObject(snapshot);
  expect(stderr).not.toContain('grunt model API');
  expect(paths).toEqual(['GET /v1/status']);
});

it('prints a single plain snapshot for a piped watch command', async () => {
  const { port, paths } = await daemon({ version: 1, updatedAt: Date.now(), activeRequests: 1,
    sources: [{ id: 'kilo', state: 'answering', active: 1, model: 'particle-ai/particle-1:free' }] });
  const { stdout } = await cli(['status', '--watch', '--port', String(port)]);
  expect(stdout.toLowerCase()).toContain('kilo');
  expect(stdout.toLowerCase()).toContain('answering');
  expect(stdout).not.toContain('\u001b');
  expect(paths).toEqual(['GET /v1/status']);
});

it('shows CLI help without booting the daemon', async () => {
  const { stdout } = await cli(['--help']);
  expect(stdout).toContain('update');
  expect(stdout).toContain('status');
  expect(stdout).toContain('--watch');
});

it('rejects unknown commands and invalid update arguments without starting the daemon or setup', async () => {
  await expect(cli(['updat'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown grunt command') });
  await expect(cli(['update', '--unexpected'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: usegrunt update') });
});

it('asks for initial setup when update has no installed runtime, without running the wizard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-cli-update-missing-'));
  try {
    await expect(cli(['update'], { MILO_CONFIG_DIR: directory })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('run npx usegrunt setup first')
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
