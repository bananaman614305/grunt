import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ipaddr from 'ipaddr.js';

export const DECLARATIVE_OPENAI_INSTALL = 'declarative:openai';
export const DECLARATIVE_APP_INSTALL = 'declarative:app';
export const FUTURE_DECLARATIVE_INSTALL = /^declarative:[a-z][a-z0-9-]{0,31}$/;
export const DECLARATIVE_ZERO_PRICE_CHECKS = ['none', 'models_catalog'] as const;
export type DeclarativeZeroPriceCheck = typeof DECLARATIVE_ZERO_PRICE_CHECKS[number];
export const DECLARATIVE_APP_EXECUTIONS = ['inference', 'delegated'] as const;
export type DeclarativeAppExecution = typeof DECLARATIVE_APP_EXECUTIONS[number];
export const DECLARATIVE_APP_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
export type DeclarativeAppPlatform = typeof DECLARATIVE_APP_PLATFORMS[number];

export interface DeclarativeOpenAiConfig {
  baseUrl: string;
  apiPath: string;
  modelsEndpoint?: string;
  zeroPriceCheck: DeclarativeZeroPriceCheck;
  stream?: boolean;
  disclosure: string;
  policyVersion: string;
  policyUrl: string;
  name?: string;
  minContextLength?: number;
}

export type DeclarativeAppInstaller =
  | { type: 'npm'; package: string; bin: string; version?: string; allowPostinstall?: boolean }
  | { type: 'uv'; package: string; bin: string; version?: string }
  | { type: 'archive'; urls: Partial<Record<DeclarativeAppPlatform, string>>; bin: string; format?: 'tar.gz' | 'zip' };

export interface DeclarativeAppExpectStep {
  match: string;
  send: string;
}

export type DeclarativeAppAuth =
  | { type: 'none'; statusArgs?: string[]; statusMatch?: string; authFile?: string }
  | {
      type: 'browser-url';
      command: string[];
      allowedOrigins: string[];
      urlPattern?: string;
      pty?: boolean;
      expect?: DeclarativeAppExpectStep[];
      statusArgs?: string[];
      statusMatch?: string;
      authFile?: string;
    }
  | {
      type: 'device-code';
      command: string[];
      allowedOrigins: string[];
      urlPattern?: string;
      codePattern: string;
      pty?: boolean;
      statusArgs?: string[];
      statusMatch?: string;
      authFile?: string;
    };

export interface DeclarativeAppOneshotOutput {
  format: 'plain' | 'json' | 'jsonl';
  textPath?: string;
  sessionIdPath?: string;
  eventTypeField?: string;
  eventTypeValue?: string;
}

export interface DeclarativeAppErrorPatterns {
  quota?: string;
  loggedOut?: string;
  refused?: string;
}

export type DeclarativeAppTransport =
  | {
      type: 'oneshot-exec';
      args: string[];
      promptInput: 'arg' | 'stdin' | 'file';
      resumeArgs?: string[];
      output: DeclarativeAppOneshotOutput;
      errors?: DeclarativeAppErrorPatterns;
    }
  | {
      type: 'acp';
      args: string[];
      modelOption?: string;
      mode?: string;
    };

export interface DeclarativeAppConfig {
  execution: DeclarativeAppExecution;
  installer: DeclarativeAppInstaller;
  auth: DeclarativeAppAuth;
  transport: DeclarativeAppTransport;
  env?: Record<string, string>;
  disclosure: string;
  policyVersion: string;
  policyUrl: string;
  name?: string;
  timeoutMs?: number;
}

export interface Adapter {
  id: string;
  kind: 'agent' | 'model';
  tier: 'stable' | 'experimental';
  weight: number;
  modalities: ('text' | 'image')[];
  install: string;
  signup?: string;
  model?: string;
  models?: string[];
  // Set by the daily provider scout (docs/router.md). Missing means possible/active.
  fit?: 'great' | 'possible' | 'poor';
  status?: 'active' | 'expiring' | 'inactive';
  expires?: string;
  // Optional page-by-page notes for the free signup: the controls to press and
  // the Grunt-supplied values to type, in order. Appended to Squire's drive goal.
  hints?: string;
  // Validated configuration for declarative:openai entries. Never carries code or commands.
  declarative?: DeclarativeOpenAiConfig;
  // Validated configuration for sandboxed declarative:app CLI entries.
  declarativeApp?: DeclarativeAppConfig;
}
export type DeclarativeAdapter = Adapter & {
  kind: 'model';
  install: typeof DECLARATIVE_OPENAI_INSTALL;
  model: string;
  signup: string;
  hints: string;
  expires: string;
  declarative: DeclarativeOpenAiConfig;
};
export type DeclarativeAppAdapter = Adapter & {
  install: typeof DECLARATIVE_APP_INSTALL;
  declarativeApp: DeclarativeAppConfig;
};
// A provider listed in the registry before Grunt ships an adapter for it. Every
// client ignores this list; the provider scout ships adapters from it.
export interface Candidate { id: string; signup: string; hints: string; name?: string; models?: string[]; docs?: string; notes?: string }
export interface Registry { version: 1; published: string; adapters: Adapter[]; candidates?: Candidate[] }
export interface RegistryError { field: string; rule: string }
// The schema constants below are shared by the validator and the published agent instructions.
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const NPM_INSTALL = /^npm:[a-z0-9@/._-]+$/;
export const PUBLISHED_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
export const DAY_PATTERN = /^\d{4}-\d\d-\d\d$/;
export const POLICY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const HINTS_MAX = 2000;
export const NOTES_MAX = 500;
export const NAME_MAX = 100;
export const MODEL_MAX = 200;
export const API_PATH_MAX = 256;
export const DISCLOSURE_MAX = 1500;
export const MIN_CONTEXT_LENGTH_MAX = 10_000_000;
export const MODELS_MAX = 20;
export const ADAPTERS_MAX = 100;
export const CANDIDATES_MAX = 100;
export const KINDS = ['agent', 'model'] as const;
export const TIERS = ['stable', 'experimental'] as const;
export const MODALITIES = ['text', 'image'] as const;
export const FITS = ['great', 'possible', 'poor'] as const;
export const STATUSES = ['active', 'expiring', 'inactive'] as const;
export const ADAPTER_FIELDS = ['id', 'kind', 'tier', 'weight', 'modalities', 'install', 'signup', 'model', 'models', 'fit', 'status', 'expires', 'hints', 'declarative', 'declarativeApp'] as const;
export const DECLARATIVE_FIELDS = ['baseUrl', 'apiPath', 'modelsEndpoint', 'zeroPriceCheck', 'stream', 'disclosure', 'policyVersion', 'policyUrl', 'name', 'minContextLength'] as const;
export const DECLARATIVE_APP_FIELDS = ['execution', 'installer', 'auth', 'transport', 'env', 'disclosure', 'policyVersion', 'policyUrl', 'name', 'timeoutMs'] as const;
export const CANDIDATE_FIELDS = ['id', 'signup', 'hints', 'name', 'models', 'docs', 'notes'] as const;
export const TIER_TOTALS = { stable: 0.8, experimental: 0.2 } as const;
export const installers: Readonly<Record<string, string>> = { freebuff: 'npm:freebuff', opencode: 'npm:opencode-ai', kilo: 'builtin:kilo', nvidia: 'builtin:nvidia', zro: 'builtin:zro', tokenharbor: 'builtin:tokenharbor', runcrate: 'builtin:runcrate', apinex: 'builtin:apinex', 'mistral-vibe': 'builtin:mistral-vibe', livekit: 'builtin:livekit', pollinations: 'builtin:pollinations', beatapi: 'builtin:beatapi', perch: 'builtin:perch', nous: 'builtin:nous', kenari: 'builtin:kenari', numes: 'builtin:numes', goedel: 'builtin:goedel', crowllm: 'builtin:crowllm', fikra: 'builtin:fikra', openference: 'builtin:openference', darus: 'builtin:darus', 'aperture-ai': 'builtin:aperture-ai', 'reflection-beam': 'builtin:reflection-beam', 'antseed-vikey': 'builtin:antseed-vikey', millionseek: 'builtin:millionseek', freepi: 'builtin:freepi', ifm: 'builtin:ifm' };
export const knownAdapters = new Set(Object.keys(installers));
// Shipped adapters with kind "model"; the other shipped adapters are agents.
export const modelAdapters = new Set(['kilo', 'nvidia', 'zro', 'tokenharbor', 'runcrate', 'apinex', 'livekit', 'pollinations', 'beatapi', 'nous', 'kenari', 'numes', 'goedel', 'crowllm', 'fikra', 'openference', 'darus', 'aperture-ai', 'reflection-beam', 'antseed-vikey', 'millionseek', 'freepi', 'ifm']);
// Shipped adapters whose code explicitly supports image input in addition to text.
export const imageAdapters = new Set<string>(['kilo']);
// Shipped adapters whose code serves exactly one model.
export const pinnedModels: Readonly<Record<string, string>> = { 'aperture-ai': 'baidu/ernie-5.5-flash-preview:free', darus: 'darus/deepseek-v4.1-flash-1017-FREE', fikra: 'deepseek-v4-1-flash-economy-free', openference: 'DeepSeek-V4.1-Flash-1017-Free', crowllm: 'glm-5.3-flash:free', 'reflection-beam': 'reflection/beam-free', millionseek: 'deepseek-v4.1-flash-free', freepi: 'deepseek-v4.1-flash', ifm: 'IFM/K2-Horizon-375B-A23B', 'antseed-vikey': 'deepseek/deepseek-v4.1-flash-free', goedel: 'deepseek/deepseek-v4.1-flash', nous: 'qwen/qwen4-max:free' };
// Explicit fallback descriptors do not enroll sources in the bundled registry.
export const localOptInAdapters: readonly Adapter[] = [
  { id: 'crowllm', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:crowllm', model: 'glm-5.3-flash:free' },
  { id: 'antseed-vikey', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:antseed-vikey' },
  // Unverified price, terms and quality: the same low weight as the other opt-ins, and only by explicit selection.
  { id: 'ifm', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:ifm', model: 'IFM/K2-Horizon-375B-A23B' },
];
export const localOptInAdapterIds = new Set(localOptInAdapters.map(adapter => adapter.id));
// Keep retired IDs as tombstones for saved selections and explicit requests.
// Clixad's installer/source are removed; its ID must not become an automatic
// fallback alias or send an old setup request through legacy provisioning.
export const disabledAdapters = new Set(['freebuff', 'apinex', 'clixad']);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonBlank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const RESERVED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.localdomain', '.lan', '.arpa'];
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLIC_TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const DISALLOWED_API_HOSTS = new Set(['localhost', 'trusty-squire-api.fly.dev']);

export function isPublicDnsHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host.length > 253 || host.endsWith('.') || host.startsWith('[') || host.includes(':')) return false;
  if (ipaddr.isValid(host)) return false;
  if (DISALLOWED_API_HOSTS.has(host) || RESERVED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every(label => DNS_LABEL.test(label)) && PUBLIC_TLD.test(labels.at(-1)!);
}

export function safePublicHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value) || value.includes('\\')) return undefined;
  if (value.includes('?') || value.includes('#') || value.includes('@')) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined;
  if (url.pathname !== '/') return undefined;
  if (value.slice('https://'.length).includes(':')) return undefined;
  if (!isPublicDnsHostname(url.hostname)) return undefined;
  return url.origin;
}

export function safePublicHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value) || value.includes('\\')) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return isPublicDnsHostname(url.hostname);
}

export function safeApiPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > API_PATH_MAX) return false;
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(value) || value.includes('//')) return false;
  return !value.split('/').some(segment => segment === '.' || segment === '..');
}

export function isDeclarativeAdapter(adapter: Pick<Adapter, 'install' | 'declarative'> | undefined): adapter is DeclarativeAdapter {
  return adapter?.install === DECLARATIVE_OPENAI_INSTALL && adapter.declarative !== undefined;
}

export function isDeclarativeAppAdapter(adapter: Pick<Adapter, 'install' | 'declarativeApp'> | undefined): adapter is DeclarativeAppAdapter {
  return adapter?.install === DECLARATIVE_APP_INSTALL && adapter.declarativeApp !== undefined;
}

export function isSupportedAdapter(adapter: Adapter): boolean {
  return !disabledAdapters.has(adapter.id) && (knownAdapters.has(adapter.id) || isDeclarativeAdapter(adapter) || isDeclarativeAppAdapter(adapter));
}

const REGEX_MAX = 256;
const SAFE_BIN_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,4}$/;
const SAFE_PACKAGE_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/i;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const SAFE_ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_ENV_KEY_PATTERN = /^(?:PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|NODE_OPTIONS|NODE_PATH|SHELL|BASH_ENV|ENV|ZDOTDIR|GRUNT_|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|XDG_)/i;
const SAFE_DOT_PATH_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}$/;
const SAFE_REL_FILE_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,160}$/;
// Reject nested quantifiers such as (a+)+, (a*)*, (.+){2,} that can cause catastrophic backtracking.
const NESTED_QUANTIFIER_PATTERN = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

export function safeRegexPattern(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > REGEX_MAX || CONTROL_CHARS.test(value)) return false;
  if (NESTED_QUANTIFIER_PATTERN.test(value)) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function safeArgList(value: unknown, maxItems = 32, maxLength = 256): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === 'string' && item.length <= maxLength && !CONTROL_CHARS.test(item));
}

function safeBinPath(value: unknown): value is string {
  return typeof value === 'string' && SAFE_BIN_PATTERN.test(value) && !value.split('/').some(segment => segment === '.' || segment === '..');
}

const httpsUrl = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const hintsValid = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= HINTS_MAX;
const dayValid = (value: unknown) => typeof value === 'string' && DAY_PATTERN.test(value) && Number.isFinite(Date.parse(value));
// Fixed rule text for each field, shared by the write errors and the published instructions.
export const DECLARATIVE_RULES = {
  baseUrl: 'must be a public https origin without path, port, credentials, query, fragment, IP literal, or private/local host',
  apiPath: `must be a normalized URL path starting with / of at most ${API_PATH_MAX} safe characters`,
  modelsEndpoint: `must be a normalized URL path starting with / of at most ${API_PATH_MAX} safe characters; required when zeroPriceCheck is models_catalog`,
  zeroPriceCheck: `must be one of ${DECLARATIVE_ZERO_PRICE_CHECKS.join(', ')}`,
  stream: 'must be a boolean when provided',
  disclosure: `must be non-blank text of at most ${DISCLOSURE_MAX} characters without control characters`,
  policyVersion: `must match ${POLICY_VERSION_PATTERN}`,
  policyUrl: 'must be a public https URL without credentials, IP literal, or private/local host',
  name: `must be non-blank text of at most ${NAME_MAX} characters without control characters`,
  minContextLength: `must be a safe integer from 1 to ${MIN_CONTEXT_LENGTH_MAX}`
} as const satisfies Record<typeof DECLARATIVE_FIELDS[number], string>;
export const ADAPTER_RULES = {
  id: `must match ${ID_PATTERN}`,
  kind: `must be one of ${KINDS.join(', ')}; a shipped adapter keeps its shipped kind and a declarative adapter must be model`,
  tier: `must be one of ${TIERS.join(', ')}`,
  weight: 'must be a number greater than 0 and at most 1',
  modalities: `must be a non-empty list of distinct values from ${MODALITIES.join(', ')}; a shipped adapter may include image only when it supports image input, and a declarative adapter must be text only`,
  install: `must be the shipped installer for a shipped adapter id, ${DECLARATIVE_OPENAI_INSTALL}, ${DECLARATIVE_APP_INSTALL}, another declarative:<type>, or npm:<package>`,
  signup: 'must be an https URL without credentials; required and public DNS only for a declarative adapter',
  model: `must be a non-blank string; required (at most ${MODEL_MAX} characters) for a declarative adapter; a single-model shipped adapter keeps its shipped model`,
  models: `only opencode may list models: 1 to ${MODELS_MAX} distinct non-blank strings, without model`,
  fit: `must be one of ${FITS.join(', ')}`,
  status: `must be one of ${STATUSES.join(', ')}`,
  expires: 'must be a YYYY-MM-DD day; required for a declarative adapter',
  hints: `must be non-blank text of at most ${HINTS_MAX} characters; required for a declarative adapter`,
  declarative: `required JSON object when install is ${DECLARATIVE_OPENAI_INSTALL}, forbidden otherwise`,
  declarativeApp: `required JSON object when install is ${DECLARATIVE_APP_INSTALL}, forbidden otherwise`
} as const satisfies Record<typeof ADAPTER_FIELDS[number], string>;
export const CANDIDATE_RULES = {
  id: ADAPTER_RULES.id,
  signup: ADAPTER_RULES.signup,
  hints: ADAPTER_RULES.hints,
  name: `must be non-blank text of at most ${NAME_MAX} characters`,
  models: `must be 1 to ${MODELS_MAX} distinct non-blank strings`,
  docs: 'must be an https URL without credentials',
  notes: `must be text of at most ${NOTES_MAX} characters`
} as const satisfies Record<typeof CANDIDATE_FIELDS[number], string>;
export function declarativeErrors(value: unknown): RegistryError[] {
  const d = record(value);
  if (!d) return [{ field: 'declarative', rule: ADAPTER_RULES.declarative }];
  const errors: RegistryError[] = [];
  const check = (ok: unknown, field: keyof typeof DECLARATIVE_RULES) => {
    if (!ok) errors.push({ field: `declarative.${field}`, rule: DECLARATIVE_RULES[field] });
  };
  for (const key of Object.keys(d)) {
    if (!DECLARATIVE_FIELDS.includes(key as never)) errors.push({ field: `declarative.${key}`, rule: 'is not a declarative field' });
  }
  check(safePublicHttpsOrigin(d.baseUrl) !== undefined, 'baseUrl');
  check(safeApiPath(d.apiPath), 'apiPath');
  const zeroPriceValid = DECLARATIVE_ZERO_PRICE_CHECKS.includes(d.zeroPriceCheck as never);
  check(zeroPriceValid, 'zeroPriceCheck');
  check(d.zeroPriceCheck === 'models_catalog' ? safeApiPath(d.modelsEndpoint) : d.modelsEndpoint === undefined || safeApiPath(d.modelsEndpoint), 'modelsEndpoint');
  check(d.stream === undefined || typeof d.stream === 'boolean', 'stream');
  check(nonBlank(d.disclosure) && d.disclosure.length <= DISCLOSURE_MAX && !TEXT_CONTROL_CHARS.test(d.disclosure), 'disclosure');
  check(typeof d.policyVersion === 'string' && POLICY_VERSION_PATTERN.test(d.policyVersion), 'policyVersion');
  check(safePublicHttpsUrl(d.policyUrl), 'policyUrl');
  check(d.name === undefined || nonBlank(d.name) && d.name.length <= NAME_MAX && !CONTROL_CHARS.test(d.name), 'name');
  check(d.minContextLength === undefined || typeof d.minContextLength === 'number' && Number.isSafeInteger(d.minContextLength) && d.minContextLength >= 1 && d.minContextLength <= MIN_CONTEXT_LENGTH_MAX, 'minContextLength');
  return errors;
}
export function declarativeAppErrors(value: unknown): RegistryError[] {
  const d = record(value);
  if (!d) return [{ field: 'declarativeApp', rule: ADAPTER_RULES.declarativeApp }];
  const errors: RegistryError[] = [];
  const push = (field: string, rule: string) => errors.push({ field: `declarativeApp.${field}`, rule });
  for (const key of Object.keys(d)) {
    if (!DECLARATIVE_APP_FIELDS.includes(key as never)) push(key, 'is not a declarativeApp field');
  }
  if (!DECLARATIVE_APP_EXECUTIONS.includes(d.execution as never)) {
    push('execution', `must be one of ${DECLARATIVE_APP_EXECUTIONS.join(', ')}`);
  }
  // Validate installer
  const inst = record(d.installer);
  if (!inst) {
    push('installer', 'must be a JSON object');
  } else if (inst.type === 'npm') {
    for (const key of Object.keys(inst)) if (!['type', 'package', 'bin', 'version', 'allowPostinstall'].includes(key)) push(`installer.${key}`, 'unknown installer field');
    if (typeof inst.package !== 'string' || !SAFE_PACKAGE_PATTERN.test(inst.package)) push('installer.package', 'must be a valid npm package name');
    if (!safeBinPath(inst.bin)) push('installer.bin', 'must be a safe relative binary name');
    if (inst.version !== undefined && (typeof inst.version !== 'string' || !SAFE_VERSION_PATTERN.test(inst.version))) push('installer.version', 'must be a valid package version');
    if (inst.allowPostinstall !== undefined && typeof inst.allowPostinstall !== 'boolean') push('installer.allowPostinstall', 'must be a boolean');
  } else if (inst.type === 'uv') {
    for (const key of Object.keys(inst)) if (!['type', 'package', 'bin', 'version'].includes(key)) push(`installer.${key}`, 'unknown installer field');
    if (typeof inst.package !== 'string' || !SAFE_PACKAGE_PATTERN.test(inst.package)) push('installer.package', 'must be a valid Python package name');
    if (!safeBinPath(inst.bin)) push('installer.bin', 'must be a safe relative binary name');
    if (inst.version !== undefined && (typeof inst.version !== 'string' || !SAFE_VERSION_PATTERN.test(inst.version))) push('installer.version', 'must be a valid package version');
  } else if (inst.type === 'archive') {
    for (const key of Object.keys(inst)) if (!['type', 'urls', 'bin', 'format'].includes(key)) push(`installer.${key}`, 'unknown installer field');
    const urls = record(inst.urls);
    if (!urls || !Object.keys(urls).length) {
      push('installer.urls', 'must map at least one platform to a public https URL');
    } else {
      for (const [platform, url] of Object.entries(urls)) {
        if (!DECLARATIVE_APP_PLATFORMS.includes(platform as never)) push(`installer.urls.${platform}`, 'unsupported platform');
        else if (!safePublicHttpsUrl(url)) push(`installer.urls.${platform}`, 'must be a public https URL');
      }
    }
    if (!safeBinPath(inst.bin)) push('installer.bin', 'must be a safe relative binary path');
    if (inst.format !== undefined && !['tar.gz', 'zip'].includes(String(inst.format))) push('installer.format', 'must be tar.gz or zip');
  } else {
    push('installer.type', 'must be npm, uv, or archive');
  }
  // Validate auth
  const auth = record(d.auth);
  if (!auth) {
    push('auth', 'must be a JSON object');
  } else {
    const commonAuth = ['type', 'statusArgs', 'statusMatch', 'authFile'];
    if (auth.statusArgs !== undefined && !safeArgList(auth.statusArgs, 16)) push('auth.statusArgs', 'must be a list of safe CLI arguments');
    if (auth.statusMatch !== undefined && !safeRegexPattern(auth.statusMatch)) push('auth.statusMatch', 'must be a safe regular expression');
    if (auth.authFile !== undefined && (typeof auth.authFile !== 'string' || !SAFE_REL_FILE_PATTERN.test(auth.authFile))) push('auth.authFile', 'must be a safe relative path inside app home');
    if (auth.type === 'none') {
      for (const key of Object.keys(auth)) if (!commonAuth.includes(key)) push(`auth.${key}`, 'unknown auth field');
    } else if (auth.type === 'browser-url' || auth.type === 'device-code') {
      const allowed = auth.type === 'browser-url'
        ? [...commonAuth, 'command', 'allowedOrigins', 'urlPattern', 'pty', 'expect']
        : [...commonAuth, 'command', 'allowedOrigins', 'urlPattern', 'codePattern', 'pty'];
      for (const key of Object.keys(auth)) if (!allowed.includes(key)) push(`auth.${key}`, 'unknown auth field');
      if (!safeArgList(auth.command, 16) || !auth.command.length) push('auth.command', 'must be a non-empty list of safe CLI arguments');
      if (!Array.isArray(auth.allowedOrigins) || !auth.allowedOrigins.length || auth.allowedOrigins.length > 8
        || !auth.allowedOrigins.every(origin => safePublicHttpsOrigin(origin) !== undefined)) {
        push('auth.allowedOrigins', 'must list 1 to 8 public https origins');
      }
      if (auth.urlPattern !== undefined && !safeRegexPattern(auth.urlPattern)) push('auth.urlPattern', 'must be a safe regular expression');
      if (auth.pty !== undefined && typeof auth.pty !== 'boolean') push('auth.pty', 'must be a boolean');
      if (auth.type === 'device-code' && !safeRegexPattern(auth.codePattern)) push('auth.codePattern', 'must be a safe regular expression');
      if (auth.type === 'browser-url' && auth.expect !== undefined) {
        if (!Array.isArray(auth.expect) || auth.expect.length > 8) {
          push('auth.expect', 'must be at most 8 expect steps');
        } else {
          for (let i = 0; i < auth.expect.length; i++) {
            const step = record(auth.expect[i]);
            if (!step || !safeRegexPattern(step.match) || typeof step.send !== 'string' || step.send.length > 64) {
              push(`auth.expect[${i}]`, 'must have safe regex match and short send string');
            }
          }
        }
      }
    } else {
      push('auth.type', 'must be none, browser-url, or device-code');
    }
  }
  // Validate transport
  const transport = record(d.transport);
  if (!transport) {
    push('transport', 'must be a JSON object');
  } else if (transport.type === 'oneshot-exec') {
    for (const key of Object.keys(transport)) if (!['type', 'args', 'promptInput', 'resumeArgs', 'output', 'errors'].includes(key)) push(`transport.${key}`, 'unknown transport field');
    if (!safeArgList(transport.args, 32)) push('transport.args', 'must be a list of safe CLI arguments');
    if (!['arg', 'stdin', 'file'].includes(String(transport.promptInput))) push('transport.promptInput', 'must be arg, stdin, or file');
    if (transport.resumeArgs !== undefined && !safeArgList(transport.resumeArgs, 16)) push('transport.resumeArgs', 'must be a list of safe CLI arguments');
    const out = record(transport.output);
    if (!out || !['plain', 'json', 'jsonl'].includes(String(out.format))) {
      push('transport.output', 'must specify format plain, json, or jsonl');
    } else {
      for (const key of Object.keys(out)) if (!['format', 'textPath', 'sessionIdPath', 'eventTypeField', 'eventTypeValue'].includes(key)) push(`transport.output.${key}`, 'unknown output field');
      if (out.textPath !== undefined && (typeof out.textPath !== 'string' || !SAFE_DOT_PATH_PATTERN.test(out.textPath))) push('transport.output.textPath', 'must be a safe dot path');
      if (out.sessionIdPath !== undefined && (typeof out.sessionIdPath !== 'string' || !SAFE_DOT_PATH_PATTERN.test(out.sessionIdPath))) push('transport.output.sessionIdPath', 'must be a safe dot path');
      if (out.eventTypeField !== undefined && (typeof out.eventTypeField !== 'string' || !SAFE_DOT_PATH_PATTERN.test(out.eventTypeField))) push('transport.output.eventTypeField', 'must be a safe dot path');
      if (out.eventTypeValue !== undefined && (!nonBlank(out.eventTypeValue) || out.eventTypeValue.length > 64 || CONTROL_CHARS.test(out.eventTypeValue))) push('transport.output.eventTypeValue', 'must be a short non-blank string');
    }
    if (transport.errors !== undefined) {
      const errs = record(transport.errors);
      if (!errs) push('transport.errors', 'must be an object');
      else {
        for (const [k, v] of Object.entries(errs)) {
          if (!['quota', 'loggedOut', 'refused'].includes(k)) push(`transport.errors.${k}`, 'unknown error class');
          else if (!safeRegexPattern(v)) push(`transport.errors.${k}`, 'must be a safe regular expression');
        }
      }
    }
  } else if (transport.type === 'acp') {
    for (const key of Object.keys(transport)) if (!['type', 'args', 'modelOption', 'mode'].includes(key)) push(`transport.${key}`, 'unknown transport field');
    if (!safeArgList(transport.args, 32)) push('transport.args', 'must be a list of safe CLI arguments');
    if (transport.modelOption !== undefined && (!nonBlank(transport.modelOption) || transport.modelOption.length > 128 || CONTROL_CHARS.test(transport.modelOption))) push('transport.modelOption', 'must be a non-blank string');
    if (transport.mode !== undefined && (!nonBlank(transport.mode) || transport.mode.length > 64 || CONTROL_CHARS.test(transport.mode))) push('transport.mode', 'must be a non-blank string');
  } else {
    push('transport.type', 'must be oneshot-exec or acp');
  }
  // Validate env
  if (d.env !== undefined) {
    const env = record(d.env);
    if (!env || Object.keys(env).length > 32) {
      push('env', 'must be a JSON object with at most 32 entries');
    } else {
      for (const [key, val] of Object.entries(env)) {
        if (!SAFE_ENV_KEY_PATTERN.test(key) || FORBIDDEN_ENV_KEY_PATTERN.test(key)) push(`env.${key}`, 'unsafe or reserved environment variable name');
        else if (typeof val !== 'string' || val.length > 512 || CONTROL_CHARS.test(val)) push(`env.${key}`, 'must be a safe string value');
      }
    }
  }
  if (!nonBlank(d.disclosure) || d.disclosure.length > DISCLOSURE_MAX || TEXT_CONTROL_CHARS.test(d.disclosure)) push('disclosure', DECLARATIVE_RULES.disclosure);
  if (typeof d.policyVersion !== 'string' || !POLICY_VERSION_PATTERN.test(d.policyVersion)) push('policyVersion', DECLARATIVE_RULES.policyVersion);
  if (!safePublicHttpsUrl(d.policyUrl)) push('policyUrl', DECLARATIVE_RULES.policyUrl);
  if (d.name !== undefined && (!nonBlank(d.name) || d.name.length > NAME_MAX || CONTROL_CHARS.test(d.name))) push('name', DECLARATIVE_RULES.name);
  if (d.timeoutMs !== undefined && (typeof d.timeoutMs !== 'number' || !Number.isSafeInteger(d.timeoutMs) || d.timeoutMs < 1000 || d.timeoutMs > 600000)) {
    push('timeoutMs', 'must be an integer between 1000 and 600000');
  }
  return errors;
}
// One adapter entry's schema violations, with fixed rule text. Empty means valid.
export function adapterErrors(value: unknown): RegistryError[] {
  const a = record(value);
  if (!a) return [{ field: 'entry', rule: 'must be a JSON object' }];
  const errors: RegistryError[] = [];
  const check = (ok: unknown, field: keyof typeof ADAPTER_RULES) => { if (!ok && !errors.some(error => error.field === field)) errors.push({ field, rule: ADAPTER_RULES[field] }); };
  const id = typeof a.id === 'string' && ID_PATTERN.test(a.id) ? a.id : undefined;
  const known = id !== undefined && knownAdapters.has(id);
  const disabled = id !== undefined && disabledAdapters.has(id);
  const declarativeInstall = a.install === DECLARATIVE_OPENAI_INSTALL;
  const declarativeAppInstall = a.install === DECLARATIVE_APP_INSTALL;
  const futureDeclarative = typeof a.install === 'string' && FUTURE_DECLARATIVE_INSTALL.test(a.install) && !declarativeInstall && !declarativeAppInstall;
  const modalities = Array.isArray(a.modalities) ? a.modalities as unknown[] : undefined;
  check(id, 'id');
  check(KINDS.includes(a.kind as never), 'kind');
  check(TIERS.includes(a.tier as never), 'tier');
  check(typeof a.weight === 'number' && Number.isFinite(a.weight) && a.weight > 0 && a.weight <= 1, 'weight');
  check(modalities && modalities.length && modalities.every(m => MODALITIES.includes(m as never)) && new Set(modalities).size === modalities.length, 'modalities');
  check(typeof a.install === 'string' && (NPM_INSTALL.test(a.install) || known && a.install === installers[id as string] || !known && !disabled && (declarativeInstall || declarativeAppInstall || futureDeclarative)), 'install');
  check(a.model === undefined || nonBlank(a.model), 'model');
  check(a.models === undefined || a.id === 'opencode' && a.model === undefined && Array.isArray(a.models) && a.models.length && a.models.length <= MODELS_MAX
    && a.models.every(nonBlank) && new Set(a.models).size === a.models.length, 'models');
  check(a.fit === undefined || FITS.includes(a.fit as never), 'fit');
  check(a.status === undefined || STATUSES.includes(a.status as never), 'status');
  check(a.hints === undefined || hintsValid(a.hints), 'hints');
  check(a.expires === undefined || dayValid(a.expires), 'expires');
  check(a.signup === undefined || httpsUrl(a.signup), 'signup');
  // Known adapters have fixed installers and capabilities; registry data never supplies code.
  if (known) {
    check(a.kind === (modelAdapters.has(id as string) ? 'model' : 'agent'), 'kind');
    check(a.install === installers[id as string], 'install');
    check(!modalities || modalities.includes('text') && modalities.every(m => m === 'text' || m === 'image' && imageAdapters.has(id as string)), 'modalities');
    check(pinnedModels[id as string] === undefined || a.model === pinnedModels[id as string], 'model');
    check(a.declarative === undefined, 'declarative');
    check(a.declarativeApp === undefined, 'declarativeApp');
  } else if (declarativeInstall && !disabled) {
    check(a.kind === 'model', 'kind');
    check(!modalities || modalities.every(m => m === 'text'), 'modalities');
    check(nonBlank(a.model) && a.model.length <= MODEL_MAX && !CONTROL_CHARS.test(a.model), 'model');
    check(a.models === undefined, 'models');
    check(safePublicHttpsUrl(a.signup), 'signup');
    check(hintsValid(a.hints), 'hints');
    check(dayValid(a.expires), 'expires');
    check(a.declarativeApp === undefined, 'declarativeApp');
    errors.push(...declarativeErrors(a.declarative));
  } else if (declarativeAppInstall && !disabled) {
    const appCfg = record(a.declarativeApp);
    const expectedKind = appCfg?.execution === 'delegated' ? 'agent' : 'model';
    check(a.kind === expectedKind, 'kind');
    check(!modalities || modalities.every(m => m === 'text'), 'modalities');
    check(a.models === undefined, 'models');
    check(a.signup === undefined || safePublicHttpsUrl(a.signup), 'signup');
    check(a.declarative === undefined, 'declarative');
    errors.push(...declarativeAppErrors(a.declarativeApp));
  } else {
    check(a.declarative === undefined, 'declarative');
    check(a.declarativeApp === undefined, 'declarativeApp');
  }
  return errors;
}
// One candidate entry's schema violations, with fixed rule text. Empty means valid.
export function candidateErrors(value: unknown): RegistryError[] {
  const c = record(value);
  if (!c) return [{ field: 'entry', rule: 'must be a JSON object' }];
  const errors: RegistryError[] = [];
  const check = (ok: unknown, field: keyof typeof CANDIDATE_RULES) => { if (!ok) errors.push({ field, rule: CANDIDATE_RULES[field] }); };
  check(typeof c.id === 'string' && ID_PATTERN.test(c.id), 'id');
  check(httpsUrl(c.signup), 'signup');
  check(hintsValid(c.hints), 'hints');
  check(c.name === undefined || nonBlank(c.name) && c.name.length <= NAME_MAX, 'name');
  check(c.models === undefined || Array.isArray(c.models) && c.models.length && c.models.length <= MODELS_MAX && c.models.every(nonBlank)
    && new Set(c.models).size === c.models.length, 'models');
  check(c.docs === undefined || httpsUrl(c.docs), 'docs');
  check(c.notes === undefined || typeof c.notes === 'string' && c.notes.length <= NOTES_MAX, 'notes');
  for (const key of Object.keys(c)) if (!CANDIDATE_FIELDS.includes(key as never)) errors.push({ field: key, rule: 'is not a candidate field' });
  return errors;
}
export function validateRegistry(value: unknown): Registry {
  const fail = () => { throw new Error('Invalid adapter registry'); };
  const registry = record(value);
  if (!registry || registry.version !== 1 || typeof registry.published !== 'string' || !PUBLISHED_PATTERN.test(registry.published) || !Number.isFinite(Date.parse(registry.published))
    || !Array.isArray(registry.adapters) || !registry.adapters.length || registry.adapters.length > ADAPTERS_MAX) return fail();
  const ids = new Set<string>();
  const weights = { stable: 0, experimental: 0 };
  for (const item of registry.adapters as unknown[]) {
    if (adapterErrors(item).length) return fail();
    const a = item as Adapter;
    if (ids.has(a.id)) return fail();
    ids.add(a.id);
    weights[a.tier] += a.weight;
  }
  if (weights.stable && weights.experimental && (Math.abs(weights.stable - TIER_TOTALS.stable) > 1e-9 || Math.abs(weights.experimental - TIER_TOTALS.experimental) > 1e-9)) return fail();
  if ('candidates' in registry) {
    if (!Array.isArray(registry.candidates) || registry.candidates.length > CANDIDATES_MAX) return fail();
    for (const item of registry.candidates as unknown[]) {
      if (candidateErrors(item).length) return fail();
      const candidate = item as Candidate;
      if (ids.has(candidate.id)) return fail();
      ids.add(candidate.id);
    }
  }
  return structuredClone(value) as Registry;
}
const packaged = new URL('./registry/adapters.json', import.meta.url);
export const bundledRegistry = validateRegistry(JSON.parse(readFileSync(existsSync(packaged) ? packaged : new URL('../registry/adapters.json', import.meta.url), 'utf8')));

if (typeof GRUNT_DAEMON_BUNDLE === 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateRegistry(JSON.parse(readFileSync(process.argv[2] ?? 'registry/adapters.json', 'utf8')));
  console.log('Adapter registry is valid');
}
