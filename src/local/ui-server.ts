import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import ipaddr from 'ipaddr.js';
import { gruntEnv } from '../brand.js';
import { installedPort } from './dashboard.js';
import { installedRuntimeVersion } from './runtime-version.js';
import { collectUiSnapshot, parseUiWindow } from './ui-data.js';
import type { UiSnapshot, UiWindow } from './ui-data.js';
import { renderStaticSnapshotHtml, renderUiHtml, renderUnauthorizedHtml, UI_CLIENT_JS, UI_CSS } from './ui-assets.js';
import { renderTerminalQr } from './ui-qr.js';

export const DEFAULT_UI_PORT = 8789;
const SESSION_COOKIE = 'grunt_ui_session';
const CSP_HEADER = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const uiHelp = `Usage: usegrunt ui [options]
Alias: usegrunt dashboard [options]

Open a local read-only web console showing live routes, tokens spent,
remaining usage, and reset countdowns.

Options:
  --port <1-65535>     Local Grunt daemon port (default: GRUNT_PORT, installed port, or 8788)
  --ui-port <0-65535>  UI server port (default: ${DEFAULT_UI_PORT}, falls back if busy)
  --no-open            Print the URL without launching a browser
  --bind <ip>          Bind the read-only UI to a specific local LAN/Tailscale IPv4
                       (protects access with a per-session HttpOnly token & QR code)
  --tailscale          Auto-detect the Tailscale IPv4 (100.64.0.0/10) and bind with token + QR
  --snapshot <file>    Write a static offline HTML report and exit
  -h, --help           Show this help`;

function safeTokenEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function validateBindHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '*') {
    throw new Error('Refusing wildcard bind address; pass a specific loopback, LAN, or Tailscale IPv4 address');
  }
  if (!ipaddr.isValid(trimmed)) throw new Error(`Invalid bind IP address: ${trimmed}`);
  const parsed = ipaddr.parse(trimmed);
  if (parsed.kind() !== 'ipv4') throw new Error('Only specific IPv4 addresses are supported for --bind');
  const range = parsed.range();
  if (range !== 'loopback' && range !== 'private' && range !== 'carrierGradeNat') {
    throw new Error(`Refusing non-private bind address (${range}); bind only to loopback, LAN, or Tailscale IPv4`);
  }
  return parsed.toNormalizedString();
}

export function detectTailscaleIpv4(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (ipaddr.isValid(entry.address) && ipaddr.parse(entry.address).range() === 'carrierGradeNat') {
        return entry.address;
      }
    }
  }
  return undefined;
}

export function isHeadlessEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

export interface UiAppOptions {
  daemonPort: number;
  uiPort: () => number;
  bindHost?: string;
  sessionToken?: string;
  version?: string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
  pollActiveMs?: number;
  pollIdleMs?: number;
}

interface StreamHub {
  subscribe(send: (snapshot: UiSnapshot) => void): () => void;
  close(): void;
}

function createWindowHub(options: {
  window: UiWindow;
  daemonPort: number;
  fetcher?: typeof fetch;
  now?: () => number;
  pollActiveMs: number;
  pollIdleMs: number;
}): StreamHub {
  const listeners = new Set<(snapshot: UiSnapshot) => void>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let closed = false;
  let lastDigest = '';
  let lastSnapshot: UiSnapshot | undefined;

  const scheduleNext = (active: boolean) => {
    if (closed || !listeners.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, active ? options.pollActiveMs : options.pollIdleMs);
  };

  const tick = async () => {
    if (closed || running || !listeners.size) return;
    running = true;
    try {
      const snap = await collectUiSnapshot({
        daemonPort: options.daemonPort,
        window: options.window,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.now ? { now: options.now } : {})
      });
      const digest = JSON.stringify({ ...snap, observedAt: 0 });
      lastSnapshot = snap;
      if (digest !== lastDigest) {
        lastDigest = digest;
        for (const send of listeners) {
          try { send(snap); } catch { /* Closed client stream cleans up on abort. */ }
        }
      }
      const busy = snap.activeRequests > 0 || snap.poolState === 'switching' || snap.poolState === 'transient_error';
      scheduleNext(busy);
    } finally {
      running = false;
    }
  };

  return {
    subscribe(send) {
      listeners.add(send);
      if (lastSnapshot) send(lastSnapshot);
      if (listeners.size === 1) void tick();
      return () => {
        listeners.delete(send);
        if (!listeners.size) { clearTimeout(timer); timer = undefined; }
      };
    },
    close() {
      closed = true;
      clearTimeout(timer);
      listeners.clear();
    }
  };
}

export function createUiApp(options: UiAppOptions) {
  const app = new Hono();
  const bindHost = options.bindHost ?? '127.0.0.1';
  const isLoopback = bindHost === '127.0.0.1';
  const hubs = new Map<UiWindow, StreamHub>();

  const hubFor = (win: UiWindow): StreamHub => {
    let hub = hubs.get(win);
    if (!hub) {
      hub = createWindowHub({
        window: win,
        daemonPort: options.daemonPort,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.now ? { now: options.now } : {}),
        pollActiveMs: options.pollActiveMs ?? 1000,
        pollIdleMs: options.pollIdleMs ?? 2000
      });
      hubs.set(win, hub);
    }
    return hub;
  };

  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', CSP_HEADER);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json({ error: 'Method not allowed; Grunt UI is strictly read-only' }, 405);
    }

    const port = options.uiPort();
    const allowedHosts = isLoopback ? [`127.0.0.1:${port}`, `localhost:${port}`] : [`${bindHost}:${port}`];
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!allowedHosts.includes(host)) {
      return c.json({ error: 'Forbidden host header' }, 403);
    }

    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return c.json({ error: 'Forbidden cross-site request' }, 403);
    }

    const origin = c.req.header('origin');
    if (origin && !allowedHosts.some(h => origin === `http://${h}`)) {
      return c.json({ error: 'Forbidden cross-origin request' }, 403);
    }

    // Remote non-loopback binds require the per-session token (exchanged into HttpOnly cookie on /).
    if (!isLoopback && options.sessionToken) {
      if (c.req.path === '/app.css') {
        await next();
        return;
      }
      const queryToken = c.req.query('t');
      if (c.req.path === '/' && safeTokenEqual(queryToken, options.sessionToken)) {
        c.header('Set-Cookie', `${SESSION_COOKIE}=${options.sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
        return c.redirect('/', 303);
      }
      const cookieToken = readCookie(c.req.header('cookie'), SESSION_COOKIE);
      if (!safeTokenEqual(cookieToken, options.sessionToken)) {
        if (c.req.path.startsWith('/api/')) {
          return c.json({ error: 'Unauthorized remote UI session' }, 401);
        }
        return c.html(renderUnauthorizedHtml(bindHost, port), 401);
      }
    }

    await next();
  });

  app.get('/', c => c.html(renderUiHtml({ daemonPort: options.daemonPort, bindHost, uiPort: options.uiPort(), version: options.version })));

  app.get('/app.css', c => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(UI_CSS);
  });

  app.get('/app.js', c => {
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    return c.body(UI_CLIENT_JS);
  });

  app.get('/api/snapshot', async c => {
    const win = parseUiWindow(c.req.query('window'));
    const snap = await collectUiSnapshot({
      daemonPort: options.daemonPort,
      window: win,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.now ? { now: options.now } : {}),
      signal: c.req.raw.signal
    });
    return c.json(snap);
  });

  app.get('/api/export', async c => {
    const win = parseUiWindow(c.req.query('window'));
    const snap = await collectUiSnapshot({
      daemonPort: options.daemonPort,
      window: win,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.now ? { now: options.now } : {}),
      signal: c.req.raw.signal
    });
    const stamp = new Date(snap.observedAt).toISOString().replace(/[:.]/g, '-');
    c.header('Content-Disposition', `attachment; filename="grunt-status-${stamp}.json"`);
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(JSON.stringify(snap, null, 2));
  });

  app.get('/api/stream', c => {
    const win = parseUiWindow(c.req.query('window'));
    const hub = hubFor(win);
    return streamSSE(c, async stream => {
      let aborted = false;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const stop = () => { if (!aborted) { aborted = true; finish(); } };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener('abort', stop, { once: true });

      const keepalive = setInterval(() => {
        if (!aborted) void stream.writeSSE({ event: 'ping', data: '' }).catch(stop);
      }, 15000);
      const unsubscribe = hub.subscribe(snapshot => {
        if (!aborted) void stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) }).catch(stop);
      });
      try {
        await done;
      } finally {
        clearInterval(keepalive);
        unsubscribe();
        c.req.raw.signal.removeEventListener('abort', stop);
      }
    });
  });

  const closeHubs = () => {
    for (const hub of hubs.values()) hub.close();
    hubs.clear();
  };

  return { app, closeHubs };
}

export interface StartedUiServer {
  host: string;
  port: number;
  url: string;
  sessionToken?: string;
  close(): Promise<void>;
}

export async function startUiServer(options: {
  daemonPort: number;
  uiPort?: number;
  explicitUiPort?: boolean;
  bindHost?: string;
  version?: string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<StartedUiServer> {
  const bindHost = validateBindHost(options.bindHost ?? '127.0.0.1');
  const sessionToken = bindHost === '127.0.0.1' ? undefined : randomBytes(32).toString('base64url');
  let boundPort = options.uiPort ?? DEFAULT_UI_PORT;

  const { app, closeHubs } = createUiApp({
    daemonPort: options.daemonPort,
    uiPort: () => boundPort,
    bindHost,
    ...(sessionToken ? { sessionToken } : {}),
    version: options.version,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  const listen = (port: number) => new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: bindHost, port });
    const onError = (err: NodeJS.ErrnoException) => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address() as AddressInfo | null;
      if (addr && typeof addr.port === 'number') boundPort = addr.port;
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });

  let server: ReturnType<typeof serve>;
  try {
    server = await listen(boundPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && !options.explicitUiPort && boundPort !== 0) {
      server = await listen(0);
    } else {
      closeHubs();
      throw error;
    }
  }

  const baseUrl = `http://${bindHost}:${boundPort}`;
  const url = sessionToken ? `${baseUrl}/?t=${sessionToken}` : baseUrl;

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    closeHubs();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  };

  return { host: bindHost, port: boundPort, url, ...(sessionToken ? { sessionToken } : {}), close };
}

function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* Non-fatal if no browser opener exists. */ }
}

function parsePort(value: string, label: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}; expected a port number`);
  const num = Number(value);
  if (!Number.isInteger(num) || num < (allowZero ? 0 : 1) || num > 65535) {
    throw new Error(`Invalid ${label}; must be between ${allowZero ? 0 : 1} and 65535`);
  }
  return num;
}

export interface UiCommandDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetcher?: typeof fetch;
  now?: () => number;
  output?: (line: string) => void;
  open?: (url: string) => void;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  signal?: AbortSignal;
}

export async function uiCommand(args: string[], deps: UiCommandDeps = {}): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'ui-port': { type: 'string' },
      'no-open': { type: 'boolean' },
      bind: { type: 'string' },
      tailscale: { type: 'boolean' },
      snapshot: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  const out = deps.output ?? console.log;
  if (values.help) { out(uiHelp); return; }

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const portText = values.port ?? gruntEnv('PORT', env) ?? String(await installedPort(env));
  const daemonPort = parsePort(portText, 'Grunt daemon port');

  if (values.snapshot !== undefined) {
    if (!values.snapshot.trim()) throw new Error('Provide a file path for --snapshot');
    const snap = await collectUiSnapshot({
      daemonPort,
      window: '24h',
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps.now ? { now: deps.now } : {})
    });
    const html = renderStaticSnapshotHtml(snap);
    await writeFile(values.snapshot, html, { encoding: 'utf8', mode: 0o600 });
    out(`Wrote static Grunt status snapshot to ${values.snapshot} (${snap.daemonReachable ? `${snap.routes.length} routes` : 'daemon offline'})`);
    return;
  }

  if (values.bind && values.tailscale) throw new Error('Use either --bind <ip> or --tailscale, not both');
  let bindHost = '127.0.0.1';
  if (values.tailscale) {
    const tsIp = detectTailscaleIpv4(deps.interfaces?.());
    if (!tsIp) throw new Error('No Tailscale IPv4 address (100.64.0.0/10) found; pass --bind <ip> explicitly or connect Tailscale');
    bindHost = tsIp;
  } else if (values.bind) {
    bindHost = validateBindHost(values.bind);
  }

  const explicitUiPort = values['ui-port'] !== undefined;
  const uiPort = explicitUiPort ? parsePort(values['ui-port']!, 'UI port', true) : DEFAULT_UI_PORT;

  const started = await startUiServer({
    daemonPort,
    uiPort,
    explicitUiPort,
    bindHost,
    version: installedRuntimeVersion(),
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    ...(deps.now ? { now: deps.now } : {})
  });

  const headless = isHeadlessEnvironment(env, platform);
  out(`Grunt UI listening on ${started.url} (read-only proxy -> 127.0.0.1:${daemonPort})`);
  if (started.sessionToken) {
    out('Remote read-only session protected by a per-session HttpOnly token. Inference daemon remains loopback-only on 127.0.0.1.');
    try {
      out(renderTerminalQr(started.url));
    } catch { /* Fall back cleanly to URL only if URL exceeds QR capacity. */ }
  } else if (headless) {
    let user = 'user';
    try { user = userInfo().username; } catch { /* ignore */ }
    out(`Headless session detected. Forward from your laptop:\n  ssh -N -L ${started.port}:127.0.0.1:${started.port} ${user}@${hostname()}\nThen open http://127.0.0.1:${started.port}`);
  } else if (!values['no-open']) {
    (deps.open ?? (u => openBrowser(u, platform)))(started.url);
  }
  out('Press Ctrl-C to stop the UI server (the Grunt daemon keeps running).');

  await new Promise<void>(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      deps.signal?.removeEventListener('abort', stop);
      void started.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    deps.signal?.addEventListener('abort', stop, { once: true });
    if (deps.signal?.aborted) stop();
  });
}
