#!/usr/bin/env node
import { gruntEnv } from '../brand.js';
import { disabledAdapters, knownAdapters, localOptInAdapters } from '../registry.js';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp } from './api.js';
import { positive } from './freebuff.js';
import { Sources } from './source.js';
import { FreeLLMAPI } from './freellmapi.js';
import { Nvidia } from './nvidia.js';
import { Zro } from './zro.js';
import { TokenHarbor } from './tokenharbor.js';
import { Runcrate } from './runcrate.js';
import { MistralVibe } from './mistral-vibe.js';
import { LiveKit } from './livekit.js';
import { Pollinations } from './pollinations.js';
import { BeatAPI } from './beatapi.js';
import { AntseedVikey } from './antseed-vikey.js';
import { Kilo } from './kilo.js';
import { Clixad } from './clixad.js';
import { Perch } from './perch.js';
import { Nous } from './nous.js';
import { Kenari } from './kenari.js';
import { PromotionalApi } from './promotional-api.js';
import { CrowLLM } from './crowllm.js';
import { Aperture } from './aperture.js';
import { Darus } from './darus.js';
import { Goedel } from './goedel.js';
import { Numes, NUMES_DEEPSEEK_FLASH_MODEL } from './numes.js';
import { FREE_API_PROVIDERS } from './free-api.js';
import { RegistrySource } from './registry-source.js';
import { ManagedRouter } from './managed-router.js';
import { ConsentSource } from './consent-source.js';
import { readDataSharingConsent, requiresDataSharing } from './data-sharing.js';
import { Codex } from './codex.js';
import { OpenCode, DEFAULT_OPENCODE_MODELS } from './opencode.js';
import { Dots } from './dots.js';
import type { Source } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Registry } from '../registry.js';
import { RegistrySync } from './registry.js';
import { configDir } from './wizard.js';
import { DailyMaintenance } from './maintenance.js';
import { SourceRecovery } from './recovery.js';
import { readKiloRoute, readSetupSession } from './setup-session.js';
import { DiagnosticsStore } from './diagnostics.js';
import { createWorkerRuntime } from './worker-runtime.js';
export const HOST = '127.0.0.1';
export function configure(env = process.env, registry: () => Registry = () => bundledRegistry, anonymousKilo = () => false) {
  const url = gruntEnv('FREELLMAPI_URL', env) ?? 'http://127.0.0.1:3001/v1';
  let key = gruntEnv('FREELLMAPI_KEY', env) ?? '';
  let pending: Promise<string> | undefined;
  const loadKey = async () => {
    if (key) return key;
    pending ??= import('./setup.js').then(module => module.loadRouterKey(url)).then(value => key = value).catch(() => {
      console.error('grunt router login unavailable or invalid; will retry on the next request. Check the local router and its saved login.');
      return '';
    }).finally(() => { pending = undefined; });
    return pending;
  };
  const connection = { url, loadKey };
  const dots = new Dots({ env, timeout: positive(gruntEnv('DOTS_TIMEOUT_MS', env), 300000) });
  const opencodeModels = () => {
    const override = gruntEnv('OPENCODE_MODEL', env);
    if (override) return [override];
    const adapter = registry().adapters.find(a => a.id === 'opencode');
    // Older published registries pinned the original default. Upgrade that
    // default while retaining explicit environment and custom-model overrides.
    return adapter?.models ?? (adapter?.model && adapter.model !== 'big-pickle' ? [adapter.model] : DEFAULT_OPENCODE_MODELS);
  };
  const codexModel = gruntEnv('CODEX_MODEL', env), opencodeURL = gruntEnv('OPENCODE_URL', env);
  const numesModel = gruntEnv('NUMES_MODEL', env);
  const deepSeekFlash = numesModel === NUMES_DEEPSEEK_FLASH_MODEL;
  const registered: Source[] = [dots, new Codex(codexModel ? { model: codexModel } : {}), new ManagedRouter(new FreeLLMAPI(connection), url, configDir(env)), new Kilo({ directory: configDir(env), anonymous: anonymousKilo }), new Nvidia({ directory: configDir(env) }), new Zro({ directory: configDir(env) }), new TokenHarbor({ directory: configDir(env) }), new Runcrate({ directory: configDir(env) }), new MistralVibe({ directory: configDir(env) }), new LiveKit({ directory: configDir(env) }), new Pollinations({ directory: configDir(env) }), new BeatAPI({ directory: configDir(env) }), new Clixad({ directory: configDir(env) }), new Perch({ directory: configDir(env) }), new Nous({ directory: configDir(env), env }), new Kenari({ directory: configDir(env) }), new Numes({ directory: configDir(env), deepSeekFlash }), new Goedel({ directory: configDir(env) }), new Darus({ directory: configDir(env) }), new Aperture({ directory: configDir(env) }), new CrowLLM({ directory: configDir(env) }), new PromotionalApi('fikra', { directory: configDir(env) }), new PromotionalApi('openference', { directory: configDir(env) }), new OpenCode({ models: opencodeModels, configFile: join(configDir(env), 'opencode-free.json'), ...(opencodeURL ? { url: opencodeURL } : {}) })];
  const configured = gruntEnv('SOURCES', env)?.split(',').map(id => id.trim()) ?? registry().adapters.filter(adapter => knownAdapters.has(adapter.id)).map(adapter => adapter.id);
  const optedIn = (gruntEnv('OPT_IN_SOURCES', env)?.split(',') ?? []).map(id => id.trim())
    .filter(id => localOptInAdapters.some(adapter => adapter.id === id));
  const ids = [...new Set([...configured, ...optedIn])].filter(id => id && !disabledAdapters.has(id));
  if (numesModel !== undefined && (!deepSeekFlash || ids.length !== 1 || ids[0] !== 'numes')) {
    throw new Error('The Numes qualification model requires the exact Numes-only source');
  }
  if (ids.includes('antseed-vikey')) {
    const port = gruntEnv('ANTSEED_VIKEY_PORT', env);
    registered.push(new AntseedVikey(port ? { port } : {}));
  }
  if (ids.includes('reflection-beam')) registered.push(new Kilo({ directory: configDir(env), reflectionBeam: true }));
  const enabledOptIns = localOptInAdapters.filter(adapter => ids.includes(adapter.id));
  const localOptIns = new Set(enabledOptIns.map(adapter => adapter.id));
  const routingRegistry = () => {
    const current = registry();
    const adapters = current.adapters.filter(adapter => !localOptIns.has(adapter.id)).map(adapter => {
      if (adapter.id !== 'numes') return adapter;
      if (deepSeekFlash) return { ...adapter, model: NUMES_DEEPSEEK_FLASH_MODEL };
      const numes = { ...adapter, models: [NUMES_DEEPSEEK_FLASH_MODEL, FREE_API_PROVIDERS.numes.model] };
      delete numes.model;
      return numes;
    });
    return { ...current, adapters: [...adapters, ...enabledOptIns] };
  };
  const routing = ids.every(id => knownAdapters.has(id) || localOptIns.has(id))
    ? { registry: routingRegistry, localOptIns } : undefined;
  const sources = new Sources(ids.map(id => {
    const source = registered.find(source => source.id === id);
    if (!source) throw new Error(`Unknown grunt source: ${id}`);
    const consent = requiresDataSharing(id) && !['tokenharbor', 'nous', 'goedel', 'crowllm', 'fikra', 'openference', 'darus', 'aperture-ai'].includes(id) ? new ConsentSource(source, configDir(env)) : source;
    return !routing && knownAdapters.has(id) ? new RegistrySource(consent, routingRegistry) : consent;
  }), routing, disabledAdapters);
  sources.setWorkerRegistry(routingRegistry, localOptIns);
  return sources;
}
export function start(env = process.env) {
  let registry = structuredClone(bundledRegistry);
  let anonymousKilo = false;
  const sources = configure(env, () => registry, () => anonymousKilo);
  const directory = configDir(env);
  let diagnostics: DiagnosticsStore | undefined;
  const diagnosticReady = DiagnosticsStore.open({ directory }).then(store => { diagnostics = store; sources.setDiagnostics(store); });

  const reconcile = () => {
    sources.preparing.clear();
    for (const id of sources.pending) sources.preparing.add(id);
  };
  // Serialize snapshots so an older filesystem read cannot overwrite a newer
  // provider release while requests and registry checks run concurrently.
  let sessionRead: Promise<unknown> = Promise.resolve();
  const refreshSession = () => {
    const result = sessionRead.then(async () => {
      const session = await readSetupSession(directory);
      // Setup owns the Kilo route while it runs; afterwards keep the verified one.
      anonymousKilo = session?.owned.has('kilo') ? session.anonymousKilo === true : await readKiloRoute(directory) === 'anonymous';
      sources.pending.clear();
      for (const id of session?.pending ?? []) if (sources.sources.some(source => source.id === id)) sources.pending.add(id);
      sources.verifying.clear();
      for (const id of session?.verifying ?? []) if (sources.pending.has(id)) sources.verifying.add(id);
      sources.approvals.clear();
      for (const id of session?.approvals ?? []) if (sources.pending.has(id)) sources.approvals.add(id);
      reconcile();
      return session;
    });
    sessionRead = result.catch(() => {});
    return result;
  };
  const sync = new RegistrySync({ directory, ...(env.GRUNT_REGISTRY_URL ? { url: env.GRUNT_REGISTRY_URL } : {}),
    changed: current => { registry = current; }, notify: console.error
  });
  const maintenance = new DailyMaintenance({ directory,
    providers: () => [...new Set([...registry.adapters, ...localOptInAdapters].filter(adapter => knownAdapters.has(adapter.id) && !disabledAdapters.has(adapter.id)
      && sources.sources.some(source => source.id === adapter.id)).map(adapter => adapter.id))],
    check: async (id, signal) => {
      signal.throwIfAborted();
      const session = await refreshSession();
      if (session && (!session.owned.size || session.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      const approved = await readDataSharingConsent(directory, [id]);
      signal.throwIfAborted();
      if (requiresDataSharing(id) && !approved.includes(id)) return { outcome: 'deferred', code: 'consent' };
      const current = await refreshSession();
      signal.throwIfAborted();
      if (current && (!current.owned.size || current.owned.has(id))) return { outcome: 'deferred', code: 'foreground' };
      return sources.check(id, signal);
    }
  });
  sources.setMaintenance(() => maintenance.snapshot());
  // With no usable source, add providers by themselves (vault access, then signup).
  const recovery = new SourceRecovery({ directory,
    candidates: async () => {
      const ids: string[] = [];
      for (const source of sources.sources) {
        if (!knownAdapters.has(source.id) || disabledAdapters.has(source.id) || sources.pending.has(source.id)) continue;
        if (!await source.available().catch(() => false)) ids.push(source.id);
      }
      return ids;
    }, notify: console.error });
  sources.setRecovery(() => recovery.trigger());
  // Registry downloads and access maintenance are independent. No daemon
  // maintenance path provisions accounts or starts an interactive browser; only the
  // recovery below does, and only when no source can answer.
  const ready = Promise.all([sync.load(), diagnosticReady]).then(refreshSession);
  void ready.then(() => sync.start()).catch(() => console.error('Registry sync could not start; using the bundled list'));
  void ready.then(() => maintenance.start()).catch(() => console.error('Daily maintenance could not start; run usegrunt setup to repair local configuration'));
  const port = positive(gruntEnv('PORT', env), 8788);
  if (port > 65535) throw new Error('GRUNT_PORT must be at most 65535');
  const workerRuntime = createWorkerRuntime(sources, { directory });
  const { workers, scopes: workerScopes } = workerRuntime;
  const app = createLocalApp(sources, { port, workers, workerScopes, dotsEnv: env, log: cwd => console.error(`grunt working directory: ${cwd}`) });
  const server = serve({ fetch: async request => { await ready; await refreshSession(); return app.fetch(request); }, hostname: HOST, port }, () => console.error(`grunt model API: http://${HOST}:${port}/v1`));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await Promise.all([workerRuntime.close(), maintenance.close(), sync.close(), recovery.close()]); await sources.close(); await diagnosticReady; await diagnostics?.close(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === 'update') {
    try {
      if (process.argv.length > 3) throw new Error('Usage: usegrunt update');
      const { updateRuntime } = await import('./update.js');
      const result = await updateRuntime({ notify: line => console.log(line) });
      console.log(`grunt updated to ${result.version}; ${result.active ? `daemon ready on port ${result.port}` : 'service remains stopped'}`);
    } catch (error) { console.error(error instanceof Error ? error.message : 'Could not update grunt'); process.exitCode = 1; }
  } else if (process.argv[2] === 'status') {
    const { statusCommand } = await import('./dashboard.js');
    try { await statusCommand(process.argv.slice(3)); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Could not read grunt status'); process.exitCode = 1; }
  } else if (process.argv[2] === 'jobs') {
    try { const { jobsCommand } = await import('./jobs-cli.js'); process.exitCode = await jobsCommand(process.argv.slice(3)); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Grunt jobs command failed'); process.exitCode = 1; }
  } else if (process.argv[2] === 'workers') {
    try {
      if (process.argv[3] === 'connect') {
        const { workerConnectCommand } = await import('./worker-connect.js');
        await workerConnectCommand(process.argv.slice(4));
      } else {
        const { workerCommand } = await import('./worker-client.js');
        await workerCommand(process.argv.slice(3));
      }
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'Grunt workers command failed'); process.exitCode = 1; }
  } else if (['--help', '-h'].includes(process.argv[2] ?? '')) {
    console.log('Usage: usegrunt [setup | update | add <provider> | status [--watch] [--json] [--port <port>] | workers <run|status|retained|artifact|apply|discard|connect|mcp> | jobs <run|status|result|cancel>]\n\nRun setup to connect free sources, update to refresh the installed daemon, status --watch to view the pool, or workers to delegate independent tasks.');
  } else if (process.argv[2] === 'dots' && process.argv[3] === 'link') {
    const { dotsLink } = await import('./dots-link.js');
    try { await dotsLink(process.argv[4]); }
    catch { console.error('Dots pairing failed. Use the fallback code from the Allow page: usegrunt dots link <code>.'); process.exitCode = 1; }
  } else if (['setup', 'add'].includes(process.argv[2] ?? '') || (!process.argv[2] && basename(process.argv[1]) === 'usegrunt' && process.env.GRUNT_DAEMON !== '1')) {
    const { wizard } = await import('./wizard.js');
    try {
      await wizard(process.argv[2] === 'add' ? process.argv[3] ?? '' : undefined);
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'grunt setup failed'); process.exitCode = 1; }
  } else if (!process.argv[2] || process.argv[2] === 'serve') start();
  else { console.error('Unknown grunt command. Run usegrunt --help.'); process.exitCode = 1; }
}
