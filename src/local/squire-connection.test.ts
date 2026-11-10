import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const moduleUrl = (name: string) => pathToFileURL(require.resolve(name).replace('/dist/cjs/', '/dist/esm/')).href;

let dir: string;
const instruction = 'Connect Trusty Squire separately, then rerun milo setup';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'milo-squire-connection-'));
  vi.stubEnv('MILO_SQUIRE_HOME', '');
  vi.stubEnv('MILO_SQUIRE_XDG_CONFIG_HOME', '');
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function stubChild(body: string) {
  const bin = join(dir, 'bin.mjs');
  await writeFile(bin, body);
}

async function connection() {
  const driver = join(dir, 'driver.mjs');
  await writeFile(driver, `
    import { BrowserSquire } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/local/setup.ts')).href)};
    import { StdioClientTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/client/stdio.js'))};
    const start = StdioClientTransport.prototype.start;
    StdioClientTransport.prototype.start = function() {
      if (this._serverParams.args[1] !== 'server') throw new Error('Unexpected Squire command');
      this._serverParams.args = [${JSON.stringify(join(dir, 'bin.mjs'))}];
      return start.call(this);
    };
    const squire = new BrowserSquire();
    try { await squire.connect(); }
    catch (error) { console.log(JSON.stringify(error.message)); }
    finally { await squire.close(); }
  `);
  const { stdout } = await exec(process.execPath, ['--import', moduleUrl('tsx/esm'), driver], { timeout: 10000, env: { ...process.env } });
  return JSON.parse(stdout.trim()) as string;
}

it.each(['derived', 'explicit'])('points only the Squire child at its own home ($0 config)', async config => {
  const parentHome = homedir(), parentConfig = process.env.XDG_CONFIG_HOME;
  const squireHome = join(dir, 'own-squire');
  const configHome = config === 'explicit' ? join(dir, 'explicit-config') : join(squireHome, '.config');
  vi.stubEnv('MILO_SQUIRE_HOME', squireHome);
  if (config === 'explicit') vi.stubEnv('MILO_SQUIRE_XDG_CONFIG_HOME', configHome);
  const record = join(dir, 'spawn.json');
  await stubChild(`
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(record)}, JSON.stringify({ home: process.env.HOME, config: process.env.XDG_CONFIG_HOME }));
    process.exit(1);
  `);
  await connection();
  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ home: squireHome, config: configHome });
  expect(homedir()).toBe(parentHome);
  expect(process.env.XDG_CONFIG_HOME).toBe(parentConfig);
});

const secrets = ['sk-fake-short', 'gsk_fake_short', 'ghp_fake_short', 'eyJfake.short.signature',
  'fake-bearer', 'a'.repeat(40), 'aB09+/'.repeat(8) + '=='];
it.each(['normal', 'long', 'chunked'])('shows the last stderr reason, redacted and bounded ($0)', async mode => {
  const reason = `Trusty Squire broker not running: ${secrets.slice(0, 4).join(' ')} Bearer ${secrets[4]} ${secrets.slice(5).join(' ')}`;
  const padding = mode === 'long' ? ' more detail'.repeat(100) : '';
  await stubChild(`
    process.stderr.write('earlier diagnostic\\n');
    const line = ${JSON.stringify(reason + padding)};
    ${mode === 'chunked'
      ? "process.stderr.write(line.slice(0, 42)); setTimeout(() => { process.stderr.write(line.slice(42) + '\\n\\n'); process.exit(1); }, 20);"
      : "process.stderr.write(line + '\\n\\n'); process.exit(1);"}
  `);
  const message = await connection();
  expect(message).toMatch(new RegExp(`^${instruction}: Trusty Squire broker not running:`));
  expect(message).toContain('[redacted]');
  expect(message).not.toContain('earlier diagnostic');
  expect(message).not.toMatch(/[\r\n]/);
  expect(message.length).toBeLessThanOrEqual(300);
  for (const secret of secrets) expect(message).not.toContain(secret);
});

it.each(['rpc-error', 'tool-error', 'rpc-error-with-banner', 'initialize-error-with-banner'])('keeps the MCP connection reason ($0)', async mode => {
  await stubChild(`
    import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { CallToolRequestSchema, InitializeRequestSchema, McpError, ErrorCode } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
    if (${JSON.stringify(mode)}.endsWith('with-banner')) process.stderr.write('[trusty-squire] server v1.1.39\\n');
    const server = new Server({ name: 'offline Squire', version: '1' }, { capabilities: { tools: {} } });
    if (${JSON.stringify(mode)} === 'initialize-error-with-banner') server.setRequestHandler(InitializeRequestSchema, async () => {
      throw new McpError(ErrorCode.ConnectionClosed, 'Trusty Squire broker not running: sk-fake-short');
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== 'list_credentials') throw new Error('Unexpected provider or approval call');
      const reason = 'Trusty Squire broker not running: sk-fake-short';
      if (${JSON.stringify(mode)}.startsWith('rpc-error')) throw new McpError(ErrorCode.InternalError, reason);
      return { isError: true, content: [{ type: 'text', text: reason }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  const message = await connection();
  expect(message).toContain(`${instruction}: `);
  expect(message).toContain('Trusty Squire broker not running: [redacted]');
  expect(message).not.toContain('sk-fake-short');
});
