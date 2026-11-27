import { installedConfigRoot } from './service-migration.js';
import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { gruntEnv } from '../brand.js';
import { providerQuotaPolicy, scheduledQuotaRefill, sellerQuota } from './quota-policy.js';
import { Chalk } from 'chalk';
import { stripVTControlCharacters } from 'node:util';
import { constants } from 'node:fs';

import { join } from 'node:path';
import type { PoolSnapshot, SourceSnapshot } from './source-status.js';
import type { MaintenanceEntry } from './maintenance.js';
import type { Harness } from './harnesses.js';

const errorCodes = new Set(['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled']);
const states = new Set(['unknown', 'available', 'ready', 'answering', 'connecting', 'verifying', 'limited', 'error', 'disabled', 'unavailable', 'approval']);
const labels: Record<string, string> = {
  unknown: '? Unknown', available: '~ Available', ready: '✓ Ready', answering: '→ Answering',
  connecting: '~ Connecting', verifying: '~ Verifying', limited: '! Limited', error: '× Error',
  disabled: '- Disabled', unavailable: '- Unavailable', approval: '! Approval'
};
const names: Record<string, string> = { opencode: 'OpenCode', kilo: 'Kilo', zro: 'Zro', tokenharbor: 'TokenHarbor', runcrate: 'Runcrate', 'mistral-vibe': 'Mistral Vibe', livekit: 'LiveKit', pollinations: 'Pollinations', beatapi: 'BeatAPI', perch: 'Perch', freebuff: 'Freebuff', apinex: 'APInex' };
// Runtime status is local, but never let provider metadata control the terminal.
function safe(value: string) {
  // Strip OSC/DCS strings completely, including terminal-title and hyperlink controls.
  let ordinary = '';
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 27 && [']', 'P', '^', '_'].includes(value[i + 1] ?? '')) {
      i += 2;
      while (i < value.length && value.charCodeAt(i) !== 7 && !(value.charCodeAt(i) === 27 && value[i + 1] === '\\')) i++;
      if (value.charCodeAt(i) === 27) i++;
    } else ordinary += value[i];
  }
  return [...stripVTControlCharacters(ordinary)].filter(c => {
    const cp = c.codePointAt(0)!;
    return cp >= 32 && !(cp >= 127 && cp <= 159) && !(cp >= 0x202a && cp <= 0x202e) && !(cp >= 0x2066 && cp <= 0x2069);
  }).join('');
}
function cellWidth(c: string) {
  const cp = c.codePointAt(0)!;
  if (/\p{Mark}/u.test(c) || cp === 0x200d || cp === 0xfe0f) return 0;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) ? 2 : 1;
}
function width(value: string) { return [...stripVTControlCharacters(value)].reduce((sum, c) => sum + cellWidth(c), 0); }
function fit(value: string, limit: number, pad = false) {
  const input = safe(value); let output = '', used = 0;
  const clipped = width(input) > limit;
  for (const c of input) {
    const size = cellWidth(c);
    if (used + size > Math.max(0, limit - (clipped ? 1 : 0))) break;
    output += c; used += size;
  }
  if (clipped && limit > 0) { output += '…'; used++; }
  return output + (pad ? ' '.repeat(Math.max(0, limit - used)) : '');
}
function duration(ms: number) { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`; }
function countdown(until: number, now: number) {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.ceil(seconds / 60)}m` : `${Math.ceil(seconds / 3600)}h`;
}
export interface DashboardRenderOptions {
  width?: number; height?: number; color?: boolean; now?: number; selected?: number; details?: boolean;
  interactive?: boolean; offline?: boolean; showDisabled?: boolean; notice?: string;
}
export function renderDashboard(snapshot: PoolSnapshot, options: DashboardRenderOptions = {}) {
  const columns = Math.max(20, Math.min(240, Math.floor(options.width ?? 80)));
  const now = options.now ?? Date.now(), chalk = new Chalk({ level: options.color ? 1 : 0 });
  const offline = options.offline || now - snapshot.updatedAt > 15000 || snapshot.updatedAt > now + 60000;
  const approvals = new Set(snapshot.sources.filter(source => source.state === 'approval').map(source => source.id));
  const paint = (value: string, state: string) => {
    if (offline) return chalk.gray(value);
    if (state === 'ready' || state === 'available') return state === 'ready' ? chalk.green(value) : chalk.gray(value);
    if (state === 'answering') return chalk.cyan(value);
    if (state === 'connecting' || state === 'verifying') return chalk.blue(value);
    if (state === 'limited' || state === 'approval') return chalk.yellow(value);
    if (state === 'error') return chalk.red(value);
    return chalk.gray(value);
  };
  const all = snapshot.sources;
  const visible = all.filter(s => s.state !== 'disabled' || options.showDisabled);
  const selectedIndex = Math.max(0, Math.min(visible.length - 1, options.selected ?? 0));
  const stateOf = (source: SourceSnapshot) => offline ? 'unknown' : approvals.has(source.id) && !source.active ? 'approval' : source.state;
  const counts = new Map<string, number>();
  for (const source of all) { const state = stateOf(source); counts.set(state, (counts.get(state) ?? 0) + 1); }
  const lines: string[] = [];
  const add = (value = '') => lines.push(value);
  add(chalk.bold('grunt / sources') + (columns >= 60 ? chalk.gray(' · live local status') : ''));
  add(chalk.gray('─'.repeat(columns)));
  if (offline) {
    add(chalk.red(fit('Daemon offline or status stale', columns)));
    add(chalk.gray(fit('Ready sources cannot be confirmed.', columns)));
  } else {
    const ready = all.filter(source => {
      const state = stateOf(source);
      return state === 'ready' || (state === 'answering' && source.lastSuccessAt !== undefined);
    }).length;
    const pieces = [paint(`${ready} ready`, 'ready')];
    const available = counts.get('available') ?? 0;
    const connecting = (counts.get('connecting') ?? 0) + (counts.get('verifying') ?? 0);
    const approval = counts.get('approval') ?? 0;
    if (available) pieces.push(chalk.gray(`${available} available`));
    if (connecting) pieces.push(paint(`${connecting} connecting`, 'connecting'));
    if (approval) pieces.push(paint(`${approval} approval${approval === 1 ? '' : 's'}`, 'approval'));
    if (counts.get('limited')) pieces.push(paint(`${counts.get('limited')} limited`, 'limited'));
    if (counts.get('error')) pieces.push(paint(`${counts.get('error')} error${counts.get('error') === 1 ? '' : 's'}`, 'error'));
    // Wrap summary at separators so narrow panes keep every count legible.
    let line = '';
    for (const piece of pieces) {
      if (line && width(line) + 3 + width(piece) > columns) { add(line); line = piece; }
      else line += (line ? ' · ' : '') + piece;
    }
    add(line);
    add(chalk.gray(fit(`${snapshot.activeRequests} request${snapshot.activeRequests === 1 ? '' : 's'} active`, columns)));
  }
  add();
  const wide = columns >= 72, mid = columns >= 48;
  const sourceWidth = Math.min(19, Math.max(10, Math.floor(columns * (wide ? .23 : .48))));
  const stateWidth = wide ? 17 : columns - sourceWidth - 2;
  const modelWidth = wide ? columns - sourceWidth - stateWidth - 12 : 0;
  add(chalk.gray(fit('SOURCE', sourceWidth, true) + '  ' + fit('STATE', stateWidth, true) + (wide ? '  ' + fit('MODEL', modelWidth, true) + '  ' + fit('REPLY', 6) : '')));
  // Keep source selection visible even in short split panes.
  const hasApproval = !offline && approvals.size > 0;
  const hasHidden = !options.showDisabled && all.some(source => source.state === 'disabled');
  const maintenance = options.details ? visible[selectedIndex]?.maintenance : undefined;
  const maintenanceLines = maintenance ? 2 + (maintenance.lastCheckedAt !== undefined ? 1 : 0) : 0;
  const reserved = 4 + (hasApproval ? 2 : 0) + (hasHidden ? 1 : 0) + (options.details ? 7 + maintenanceLines : 0);
  let rowLimit = Math.max(1, (options.height ?? 100) - lines.length - reserved);
  if (rowLimit < visible.length) rowLimit = Math.max(1, rowLimit - 1);
  const start = Math.max(0, selectedIndex - rowLimit + 1), rows = visible.slice(start, start + rowLimit);
  if (!rows.length) add(chalk.gray(fit('No source observations yet.', columns)));
  rows.forEach((source, offset) => {
    const state = stateOf(source), selected = start + offset === selectedIndex;
    const title = `${selected && options.interactive !== false ? '>' : ' '} ${names[source.id] ?? source.id}`;
    const label = (labels[state] ?? labels.unknown!) + (source.active > 1 && !offline ? ` (${source.active})` : '');
    const model = source.model ?? 'Not observed';
    const reply = source.lastReplyMs === undefined ? '—' : duration(source.lastReplyMs);
    add((selected ? chalk.bold : (s: string) => s)(fit(title, sourceWidth, true)) + '  ' + paint(fit(label, stateWidth, true), state) + (wide ? '  ' + chalk.gray(fit(model, modelWidth, true)) + '  ' + chalk.gray(fit(reply, 6)) : ''));
  });
  if (rows.length < visible.length) add(chalk.gray(fit(`${start + 1}–${start + rows.length} of ${visible.length} sources${options.interactive === false ? ' · expand pane for all' : ' · ↑↓ to scroll'}`, columns)));
  const disabled = all.filter(source => source.state === 'disabled').length;
  if (disabled && !options.showDisabled) add(chalk.gray(fit(`${disabled} disabled source${disabled === 1 ? '' : 's'} hidden${options.interactive === false ? '' : ' · d to show'}`, columns)));
  if (options.details && visible[selectedIndex]) {
    const selected = visible[selectedIndex]!;
    add(); add(chalk.bold(fit(names[selected.id] ?? selected.id, columns)));
    add(fit(`Model: ${selected.model ?? 'Not observed'}`, columns));
    if (selected.detail && !offline) add(chalk.gray(fit(selected.detail, columns)));
    if (selected.lastSuccessAt) add(chalk.gray(fit(`Last success: ${new Date(selected.lastSuccessAt).toISOString()}`, columns)));
    if (selected.retryAt && !offline) add(chalk.yellow(fit(`Retry in ${countdown(selected.retryAt, now)} (reported or routing cooldown)`, columns)));
    if (maintenance) {
      add(chalk.gray(fit(`Daily check: ${maintenance.outcome ?? 'scheduled'}${maintenance.evidence ? ` · ${maintenance.evidence}` : ''}${maintenance.code ? ` (${maintenance.code})` : ''}`, columns)));
      if (maintenance.lastCheckedAt !== undefined) add(chalk.gray(fit(`Last check: ${new Date(maintenance.lastCheckedAt).toISOString()}`, columns)));
      add(chalk.gray(fit(`Next check: ${offline ? 'status stale' : maintenance.nextCheckAt > now ? `in ${countdown(maintenance.nextCheckAt, now)}` : 'due'}`, columns)));
    }
    const quota = selected.quotaPolicy ?? providerQuotaPolicy(selected.id);
    add(chalk.gray(fit(quota ? `Free quota · ${quota.detail}` : 'Credit balance: not reported', columns)));
  }
  add(); add(chalk.gray('─'.repeat(columns)));
  if (!offline && approvals.size) {
    const ids = [...approvals];
    add(chalk.yellow(fit(`${approvals.size} action${approvals.size === 1 ? '' : 's'} needed · ${ids.map(id => names[id] ?? id).join(', ')}`, columns)));
    const target = ids.length === 1 ? ids[0]! : '<provider>';
    add(fit(`Run usegrunt setup or usegrunt add ${target} to resume.`, columns));
    add(chalk.gray(fit('Other ready sources keep working.', columns)));
  } else if (options.notice) add(chalk.yellow(fit(options.notice, columns)));
  else add(chalk.gray(fit(offline ? 'Run usegrunt setup if the daemon is stopped.' : 'Available = configured; ready = verified reply.', columns)));
  add(chalk.gray(fit(options.interactive === false ? 'Live view: usegrunt status --watch' : mid ? '↑↓ select · enter details · a approvals · d disabled · q close view' : '↑↓ select · enter details · q close', columns)));
  return lines.join('\n');
}

function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
const maintenanceCodes = new Set([...errorCodes, 'busy', 'foreground', 'consent']);
function parseMaintenance(value: unknown): MaintenanceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local maintenance status');
  const entry = value as Record<string, unknown>;
  if (!number(entry.nextCheckAt) || entry.nextCheckAt > 8640000000000000) throw new Error('Invalid local maintenance status');
  const result: MaintenanceEntry = { nextCheckAt: entry.nextCheckAt };
  for (const key of ['lastAttemptAt', 'lastCheckedAt'] as const) {
    if (entry[key] !== undefined) {
      if (!number(entry[key]) || entry[key] > 8640000000000000) throw new Error('Invalid local maintenance status');
      result[key] = entry[key];
    }
  }
  if (entry.outcome !== undefined) {
    if (!['passed', 'failed', 'deferred'].includes(String(entry.outcome))) throw new Error('Invalid local maintenance status');
    result.outcome = entry.outcome as NonNullable<MaintenanceEntry['outcome']>;
  }
  if (entry.evidence !== undefined) {
    if (!['reply', 'metadata', 'local'].includes(String(entry.evidence))) throw new Error('Invalid local maintenance status');
    result.evidence = entry.evidence as NonNullable<MaintenanceEntry['evidence']>;
  }
  if (entry.code !== undefined) {
    if (typeof entry.code !== 'string' || !maintenanceCodes.has(entry.code)) throw new Error('Invalid local maintenance status');
    result.code = entry.code as NonNullable<MaintenanceEntry['code']>;
  }
  return result;
}
export function parseStatus(value: unknown): PoolSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid local status');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !number(item.updatedAt) || !number(item.activeRequests) || !Array.isArray(item.sources) || item.sources.length > 256) throw new Error('Invalid local status');
  const ids = new Set<string>();
  const sources = item.sources.map((raw: unknown): SourceSnapshot => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid local source status');
    const source = raw as Record<string, unknown>;
    if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) || ids.has(source.id) || typeof source.state !== 'string' || !states.has(source.state) || !number(source.active)) throw new Error('Invalid local source status');
    ids.add(source.id);
    const result = { id: source.id, state: source.state, active: source.active } as SourceSnapshot;
    const policy = providerQuotaPolicy(source.id);
    if (policy) result.quotaPolicy = policy;
    const refillAt = scheduledQuotaRefill(source.id, item.updatedAt as number);
    if (refillAt !== undefined) result.scheduledQuotaRefillAt = refillAt;
    const limits = source.id === 'antseed-vikey' ? sellerQuota(source.sellerQuota) : undefined;
    if (limits) result.sellerQuota = limits;
    const window = source.quotaWindow as { startedAt?: unknown; resetAt?: unknown } | null | undefined;
    if (number(window?.startedAt) && number(window?.resetAt) && window.resetAt > window.startedAt
      && window.resetAt - window.startedAt <= 31 * 86400000) result.quotaWindow = { startedAt: window.startedAt, resetAt: window.resetAt };
    if (source.maintenance !== undefined) result.maintenance = parseMaintenance(source.maintenance);
    if (source.modelKind !== undefined) {
      if (source.modelKind !== 'registry') throw new Error('Invalid local source status');
      result.modelKind = 'registry';
    }
    if (source.errorCode !== undefined) {
      if (typeof source.errorCode !== 'string' || !errorCodes.has(source.errorCode)) throw new Error('Invalid local source status');
      result.errorCode = source.errorCode as NonNullable<SourceSnapshot['errorCode']>;
    }
    for (const key of ['model', 'detail'] as const) {
      if (source[key] !== undefined) { if (typeof source[key] !== 'string' || source[key].length > 512) throw new Error('Invalid local source status'); result[key] = safe(source[key]); }
    }
    for (const key of ['lastReplyMs', 'lastSuccessAt', 'retryAt'] as const) {
      if (source[key] !== undefined) { if (!number(source[key]) || (key === 'lastSuccessAt' && source[key] > 8640000000000000)) throw new Error('Invalid local source status'); result[key] = source[key]; }
    }
    return result;
  });
  return { version: 1, updatedAt: item.updatedAt, activeRequests: item.activeRequests, sources };
}
export async function fetchStatus(options: { port: number; fetcher?: typeof fetch; signal?: AbortSignal }): Promise<PoolSnapshot> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid Grunt port');
  const signal = AbortSignal.any([AbortSignal.timeout(3000), ...(options.signal ? [options.signal] : [])]);
  const response = await (options.fetcher ?? fetch)(`http://127.0.0.1:${options.port}/v1/status`, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) throw new Error('Local Grunt status unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 131072) throw new Error('Local status response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return parseStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

type DashboardOutput = Pick<NodeJS.WriteStream, 'write' | 'on' | 'off'> & { isTTY?: boolean; columns?: number; rows?: number };
type DashboardInput = Pick<NodeJS.ReadStream, 'on' | 'off' | 'resume' | 'pause' | 'isPaused'> & { isTTY?: boolean; isRaw?: boolean; readableFlowing?: boolean | null; ref?: () => unknown; unref?: () => unknown; setRawMode?: (mode: boolean) => unknown };
export interface DashboardOptions {
  port: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; fetcher?: typeof fetch; interval?: number;
  input?: DashboardInput; output?: DashboardOutput; interactive?: boolean;
}
export interface DashboardHandle { stop(): Promise<void>; done: Promise<void>; pause(): void; resume(): void }
export function startDashboard(options: DashboardOptions): DashboardHandle {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  if (!output.isTTY || (options.env ?? process.env).TERM === 'dumb' || options.signal?.aborted) return { done: Promise.resolve(), stop: async () => {}, pause: () => {}, resume: () => {} };
  const interactive = options.interactive === true && input.isTTY === true;
  const env = options.env ?? process.env, controller = new AbortController();
  let snapshot: PoolSnapshot = { version: 1, updatedAt: Date.now(), sources: [], activeRequests: 0 };
  let offline = false, selected = 0, details = false, showDisabled = false, notice = '';
  let paused = false, screen = false, closed = false, pendingKey = '';
  let done!: () => void;
  const stopped = new Promise<void>(resolve => { done = resolve; });
  const previousRaw = input.isRaw ?? false, previousPaused = input.isPaused(), previousFlowing = input.readableFlowing;
  const leave = () => { if (screen) { output.write('\u001b[?25h\u001b[?1049l'); screen = false; } };
  const paint = () => {
    if (closed || paused) { leave(); return; }
    if (!screen) { output.write('\u001b[?1049h\u001b[?25l'); screen = true; }
    output.write('\u001b[H\u001b[2J' + renderDashboard(snapshot, { width: output.columns ?? 80, height: output.rows ?? 24, color: env.NO_COLOR === undefined && env.TERM !== 'dumb', selected, details, offline, interactive, showDisabled, notice }));
  };
  const close = () => {
    if (closed) return;
    closed = true; controller.abort();
    process.off('SIGINT', close); process.off('SIGTERM', close); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('exit', leave); options.signal?.removeEventListener('abort', close);
    output.off('resize', paint);
    if (interactive) {
      input.off('data', key); input.off('end', close); input.off('close', close);
      input.setRawMode?.(previousRaw);
      // A fresh TTY starts with readableFlowing=null but isPaused()=false.
      // Leaving it resumed after removing our listener keeps the CLI alive.
      if (previousPaused || previousFlowing !== true) { input.pause(); input.unref?.(); }
    }
    leave(); done();
  };
  const signalClose = (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => {
    const ownedElsewhere = process.listeners(signal).some(listener => listener !== handler);
    close();
    // Passive rendering must restore the terminal without replacing setup's
    // existing cancellation behavior or consuming the default signal action.
    if (!ownedElsewhere) {
      let relayed = false;
      const relay = () => { if (!relayed) { relayed = true; clearTimeout(flushDeadline); process.kill(process.pid, signal); } };
      // A custom output may ignore write callbacks; it must not consume Ctrl-C.
      const flushDeadline = setTimeout(relay, 100);
      output.write('', relay);
    }
  };
  const interrupt = () => signalClose('SIGINT', interrupt);
  const terminate = () => signalClose('SIGTERM', terminate);
  const key = (chunk: Buffer | string) => {
    if (closed || paused) return;
    pendingKey += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    while (pendingKey) {
      if ('\u001b[A'.startsWith(pendingKey) || '\u001b[B'.startsWith(pendingKey)) { if (pendingKey.length < 3) break; }
      if (pendingKey.startsWith('\u001b[A')) { selected = Math.max(0, selected - 1); pendingKey = pendingKey.slice(3); }
      else if (pendingKey.startsWith('\u001b[B')) { selected = Math.min(snapshot.sources.filter(s => showDisabled || s.state !== 'disabled').length - 1, selected + 1); pendingKey = pendingKey.slice(3); }
      else {
        const char = pendingKey[0]; pendingKey = pendingKey.slice(1);
        if (char === 'q' || char === '\u0003' || char === '\u0004') { close(); return; }
        if (char === '\r' || char === '\n') details = !details;
        if (char === 'd') { showDisabled = !showDisabled; selected = 0; }
        if (char === 'a') notice = 'Run usegrunt setup in its own terminal to resume approvals.';
      }
    }
    paint();
  };
  process.once('exit', leave);
  if (interactive) { process.once('SIGINT', close); process.once('SIGTERM', close); }
  else { process.prependOnceListener('SIGINT', interrupt); process.prependOnceListener('SIGTERM', terminate); }
  options.signal?.addEventListener('abort', close, { once: true });
  output.on('resize', paint);
  if (interactive) { if (previousFlowing !== true) input.ref?.(); input.setRawMode?.(true); input.on('data', key); input.on('end', close); input.on('close', close); input.resume(); }
  const poll = (async () => {
    while (!closed) {
      try { snapshot = await fetchStatus({ port: options.port, ...(options.fetcher ? { fetcher: options.fetcher } : {}), signal: controller.signal }); offline = false; }
      catch { if (closed) break; offline = true; }
      paint();
      if (!closed) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, Math.max(100, options.interval ?? 1000));
        controller.signal.addEventListener('abort', finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    }
  })().finally(close);
  return { done: stopped.then(() => poll), stop: async () => { close(); await poll; }, pause: () => { paused = true; leave(); }, resume: () => { paused = false; paint(); } };
}

export async function installedPort(env: NodeJS.ProcessEnv): Promise<number> {
  const directory = installedConfigRoot(env);
  let file;
  try { file = await openPrivateFile(join(directory, 'installed-port.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 8788; throw new Error('Cannot read installed Grunt port; use --port explicitly'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600) || stat.size > 32) throw new Error('Invalid installed Grunt port');
    const raw = await file.readFile('utf8');
    if (raw.length > 32) throw new Error('Invalid installed Grunt port');
    const port: unknown = JSON.parse(raw);
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid installed Grunt port');
    return port;
  } catch { throw new Error('Invalid saved Grunt port; use --port explicitly or rerun setup'); }
  finally { await file.close(); }
}

export interface StatusCommandOptions { env?: NodeJS.ProcessEnv; input?: DashboardInput; output?: DashboardOutput; fetcher?: typeof fetch; signal?: AbortSignal; interval?: number;
  // Harnesses to look for; a snapshot then ends with an opt-in launch line for each one that is installed and configured.
  harnesses?: readonly Harness[] }
export async function statusCommand(args: string[], options: StatusCommandOptions = {}) {
  const env = options.env ?? process.env, input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  let watch = false, json = false, portText = gruntEnv('PORT', env);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--watch') watch = true;
    else if (arg === '--json') json = true;
    else if (arg === '--port' && args[i + 1] !== undefined) portText = args[++i]!;
    else throw new Error('Usage: usegrunt status [--watch] [--json] [--port <1-65535>]');
  }
  portText ??= String(await installedPort(env));
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Invalid Grunt port; use --port <1-65535>');
  const port = Number(portText);
  if (json && watch) throw new Error('Use --json for one snapshot or --watch for the terminal dashboard');
  if (watch && output.isTTY && input.isTTY && env.TERM !== 'dumb') {
    await startDashboard({ ...options, env, input, output, port, interactive: true }).done;
    return;
  }
  let snapshot: PoolSnapshot;
  try { snapshot = await fetchStatus({ port, ...(options.fetcher ? { fetcher: options.fetcher } : {}), ...(options.signal ? { signal: options.signal } : {}) }); }
  catch { throw new Error(`Grunt status unavailable on 127.0.0.1:${port}. Run usegrunt setup if the daemon is stopped.`); }
  output.write((json ? JSON.stringify(snapshot, null, 2) : renderDashboard(snapshot, { width: output.columns ?? 80, color: output.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb', interactive: false })) + '\n');
  if (json || !options.harnesses) return;
  const { configuredHarnesses, launchLines } = await import('./harnesses.js');
  const lines = launchLines(await configuredHarnesses([...options.harnesses], env.PATH), port);
  if (lines.length) output.write(lines.join('\n') + '\n');
}
