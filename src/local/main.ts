#!/usr/bin/env node
import { configRoot as configDir, gruntEnv } from '../brand.js';
import { disabledAdapters, isDeclarativeAdapter, isDeclarativeAppAdapter, isSupportedAdapter, knownAdapters, localOptInAdapters } from '../registry.js';
import { recommendedAdapters, scoutRetired } from './routing.js';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp } from './api.js';
import { OBSERVATION_PATH } from './observe.js';
import type { ObservationRuntime } from './observe.js';
import { positive } from './numbers.js';
import { SourceError, Sources } from './source.js';
import { MillionSeek } from './millionseek.js';
import { FreePi } from './freepi.js';
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
import { Perch } from './perch.js';
import { Nous } from './nous.js';
import { Kenari } from './kenari.js';
import { PromotionalApi } from './promotional-api.js';
import { DeclarativeApi } from './declarative-api.js';
import { DeclarativeApp, isDeclarativeAppBackedOff } from './declarative-app.js';
import { CrowLLM } from './crowllm.js';
import { Ifm } from './ifm.js';
import { Aperture } from './aperture.js';
import { Darus } from './darus.js';
import { Goedel } from './goedel.js';
import { Numes, NUMES_DEEPSEEK_FLASH_MODEL } from './numes.js';
import { FREE_API_PROVIDERS } from './free-api.js';
import { RegistrySource } from './registry-source.js';
import { ConsentSource } from './consent-source.js';
import { RefusalSource } from './provider-refusal.js';
import { DATA_SHARING_OPT_OUT, readDataSharingConsent, refreshDataSharingConsent, registryDataSharingPolicies, requiresDataSharing } from './data-sharing.js';
import { Codex } from './codex.js';
import { OpenCode, DEFAULT_OPENCODE_MODELS } from './opencode.js';
import type { Source } from './source.js';
import { toolCapable } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Adapter, Registry } from '../registry.js';
import { RegistrySync } from './registry.js';
import { PostHogTelemetry } from './telemetry.js';
import { isDeepStrictEqual } from 'node:util';
import { createSourceMaintenance } from './runtime-maintenance.js';
import { MAX_OPEN_ROUTES, SourceRecovery, codingCapableRoute } from './recovery.js';
import { readKiloRoute, readSetupSession } from './setup-session.js';
import { DiagnosticsStore } from './diagnostics.js';
import { installedRuntimeVersion } from './runtime-version.js';
import { automaticPoolSelection } from './automatic-pool.js';
import { createRuntimeRoutingHistory } from './runtime-routing.js';
export const HOST = '127.0.0.1';
export function configure(env = process.env, registry: () => Registry = () => bundledRegistry, anonymousKilo = () => false) {
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
  const registered: Source[] = [new Codex(codexModel ? { model: codexModel } : {}), new Kilo({ directory: configDir(env), anonymous: anonymousKilo }), new Nvidia({ directory: configDir(env) }), new Zro({ directory: configDir(env) }), new TokenHarbor({ directory: configDir(env) }), new Runcrate({ directory: configDir(env) }), new MistralVibe({ directory: configDir(env) }), new LiveKit({ directory: configDir(env) }), new Pollinations({ directory: configDir(env) }), new BeatAPI({ directory: configDir(env) }), new Perch({ directory: configDir(env) }), new Nous({ directory: configDir(env), env }), new Kenari({ directory: configDir(env) }), new Numes({ directory: configDir(env), deepSeekFlash }), new Goedel({ directory: configDir(env) }), new Darus({ directory: configDir(env) }), new Aperture({ directory: configDir(env) }), new CrowLLM({ directory: configDir(env) }), new MillionSeek({ directory: configDir(env) }), new Ifm({ directory: configDir(env) }), new FreePi({ directory: configDir(env) }), new PromotionalApi('fikra', { directory: configDir(env) }), new PromotionalApi('openference', { directory: configDir(env) }), new OpenCode({ models: opencodeModels, configFile: join(configDir(env), 'opencode-free.json'), ...(opencodeURL ? { url: opencodeURL } : {}) })];
  const declared = gruntEnv('SOURCES', env)?.split(',').map(id => id.trim()).filter(Boolean);
  const curated = registry().adapters.filter(adapter => isSupportedAdapter(adapter)).map(adapter => adapter.id);
  const managed = gruntEnv('DAEMON', env) === '1';
  const selection = declared ? automaticPoolSelection(configDir(env), [...new Set(declared)], curated, managed)
    : { sources: curated, automatic: true, explicit: [] };
  const configured = selection.sources;
  const optedIn = (gruntEnv('OPT_IN_SOURCES', env)?.split(',') ?? []).map(id => id.trim())
    .filter(id => localOptInAdapters.some(adapter => adapter.id === id) || id === 'reflection-beam');
  const ids = [...new Set([...configured, ...optedIn])].filter(id => id && !disabledAdapters.has(id)
    && (!managed || id === 'codex' || knownAdapters.has(id) || curated.includes(id)));
  if (numesModel !== undefined && (!deepSeekFlash || ids.length !== 1 || ids[0] !== 'numes')) {
    throw new Error('The Numes qualification model requires the exact Numes-only source');
  }
  const explicit = new Set([...(selection.explicit ?? declared ?? []), ...optedIn]);
  const enabledOptIns = localOptInAdapters.filter(adapter => explicit.has(adapter.id));
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
    return { ...current, adapters: [...adapters, ...enabledOptIns.map(adapter => {
      const published = current.adapters.find(item => item.id === adapter.id);
      return { ...adapter,
        ...(published?.fit !== undefined ? { fit: published.fit } : {}),
        ...(published?.status !== undefined ? { status: published.status } : {}),
        ...(published?.expires !== undefined ? { expires: published.expires } : {}) };
    })] };
  };
  // A manual GRUNT_SOURCES list containing an unregistered source like Codex
  // deliberately keeps its ordered chain: the person chose that order (docs/reference.md).
  // A managed automatic pool must not lose weighted, sticky routing because one preserved
  // source has no registry entry. Those sources stay
  // selectable by model id and run only after every routed source fails.
  const isDeclarative = (id: string, current: Registry = routingRegistry()) =>
    isDeclarativeAdapter(current.adapters.find(adapter => adapter.id === id));
  const isDeclarativeApp = (id: string, current: Registry = routingRegistry()) =>
    isDeclarativeAppAdapter(current.adapters.find(adapter => adapter.id === id));
  const unrouted = new Set(ids.filter(id => !knownAdapters.has(id) && !localOptIns.has(id) && !isDeclarative(id) && !isDeclarativeApp(id)));
  const routing = !unrouted.size || selection.automatic
    ? { registry: routingRegistry, localOptIns, ...(unrouted.size ? { unrouted } : {}) } : undefined;
  if (routing && unrouted.size) {
    console.error(`grunt routing: ${[...unrouted].join(', ')} ${unrouted.size === 1 ? 'is' : 'are'} not in the provider registry, so ${unrouted.size === 1 ? 'it is' : 'they are'} not weighted or sticky-routed; ${unrouted.size === 1 ? 'it runs' : 'they run'} only when named as a model or after every routed source fails.`);
  }
  const build = (id: string, current: Registry = routingRegistry()) => {
    let source = registered.find(source => source.id === id);
    if (!source && id === 'antseed-vikey') {
      const port = gruntEnv('ANTSEED_VIKEY_PORT', env);
      source = new AntseedVikey(port ? { port } : {});
    }
    if (!source && id === 'reflection-beam') source = new Kilo({ directory: configDir(env), reflectionBeam: true });
    const declarative = isDeclarative(id, current);
    const declarativeApp = isDeclarativeApp(id, current);
    if (!source && declarative) source = new DeclarativeApi(id, { directory: configDir(env), registry: routingRegistry });
    if (!source && declarativeApp) source = new DeclarativeApp(id, { directory: configDir(env), registry: routingRegistry });
    if (source && !registered.includes(source)) registered.push(source);
    if (!source) throw new Error(`Unknown grunt source: ${id}`);
    const consent = requiresDataSharing(id) && !['tokenharbor', 'nous', 'goedel', 'crowllm', 'fikra', 'openference', 'darus', 'aperture-ai'].includes(id) ? new ConsentSource(source, configDir(env)) : source;
    // A provider that refused this account stays off until `usegrunt add <id> --force` clears it.
    const guarded = new RefusalSource(consent, configDir(env));
    return !routing && (knownAdapters.has(id) || localOptIns.has(id) || declarative || declarativeApp) ? new RegistrySource(guarded, routingRegistry) : guarded;
  };
  const sources = new Sources(ids.map(id => build(id)), routing, disabledAdapters);
  sources.setChainRegistry(routingRegistry, localOptIns);
  // Hot-add (docs/router.md): an automatic pool routes a newly listed shipped
  // or declarative adapter without a restart. A manual GRUNT_SOURCES list stays fixed.
  const adopt = (current: Registry) => {
    if (!selection.automatic) return;
    for (const adapter of current.adapters) {
      if (isSupportedAdapter(adapter)
        && !sources.sources.some(source => source.id === adapter.id)) sources.add(build(adapter.id, current));
    }
  };
  return Object.assign(sources, { adopt });
}
export function start(env = process.env) {
  const startedAt = Date.now();
  let registry = structuredClone(bundledRegistry);
  let anonymousKilo = false;
  const sources = configure(env, () => registry, () => anonymousKilo);
  const directory = configDir(env);
  let diagnostics: DiagnosticsStore | undefined;
  const runtimeVersion = installedRuntimeVersion();
  const diagnosticReady = DiagnosticsStore.open({ directory, ...(runtimeVersion ? { runtimeVersion } : {}) }).then(store => { diagnostics = store; sources.setDiagnostics(store); });
  const routingHistory = createRuntimeRoutingHistory(sources, { directory, notify: console.error });
  // Anonymous usage counts go to PostHog on each registry sync. Routing weight
  // stays local (docs/router.md#4-usage-telemetry).
  const telemetry = new PostHogTelemetry({ directory, env,
    listed: () => registry.adapters.map(adapter => adapter.id), retired: id => sources.retired(id),
    stats: () => ({ openRoutes: sources.sources.filter(source => routable(source.id) && sources.openRoute(source.id)).length, enabledSources: sources.sources.length }),
    ...(runtimeVersion ? { version: runtimeVersion } : {}) });
  sources.setFeedback((id, outcome, latencyMs) => telemetry.record(id, outcome, latencyMs));

  // The route the background pass is signing up shows as connecting in status.
  let opening: string | undefined;
  const reconcile = () => {
    sources.preparing.clear();
    for (const id of sources.pending) sources.preparing.add(id);
    if (opening && sources.sources.some(source => source.id === opening)) sources.preparing.add(opening);
  };
  // Foreground setup ends at its first working route and leaves the remaining
  // signups to the route pass, which cannot start while setup holds its session.
  let foreground = false;
  let setupReleased = false;
  // Serialize snapshots so an older filesystem read cannot overwrite a newer
  // provider release while requests and registry checks run concurrently.
  let sessionRead: Promise<unknown> = Promise.resolve();
  const refreshSession = (passive = false) => {
    const result = sessionRead.then(async () => {
      const session = await readSetupSession(directory);
      setupReleased ||= foreground && !session?.owned.size;
      foreground = Boolean(session?.owned.size);
      // Setup owns the Kilo route while it runs; afterwards keep the verified one.
      anonymousKilo = session?.owned.has('kilo') ? session.anonymousKilo === true : await readKiloRoute(directory) === 'anonymous';
      sources.pending.clear();
      for (const id of session?.pending ?? []) if (sources.sources.some(source => source.id === id)) sources.pending.add(id);
      sources.verifying.clear();
      for (const id of session?.verifying ?? []) if (sources.pending.has(id)) sources.verifying.add(id);
      reconcile();
      // Setup just finished: send its queued setup_completed event now.
      if (setupReleased && !foreground && !passive) {
        setupReleased = false;
        triggerRecovery();
        void telemetry.exchange();
      }
      return session;
    });
    sessionRead = result.catch(() => {});
    return result;
  };
  const port = positive(gruntEnv('PORT', env), 8788);
  if (port > 65535) throw new Error('GRUNT_PORT must be at most 65535');
  // Open routes (docs/router.md): listed, not scout-retired or router-retired, and configured.
  const routable = (id: string) => {
    const adapter = registry.adapters.find(adapter => adapter.id === id);
    return !!adapter && isSupportedAdapter(adapter) && !scoutRetired(adapter) && !sources.pending.has(id) && !sources.retired(id);
  };
  const configuredAccess = async (source: Source) => {
    if (!routable(source.id)) return false;
    try { return await sources.available(source); }
    catch (error) { return error instanceof SourceError && error.code === 'timeout' ? undefined : false; }
  };
  const live = async (source: Source) => await configuredAccess(source) === true && sources.openRoute(source.id);
  const maxOpenRoutes = positive(gruntEnv('MAX_OPEN_ROUTES', env), MAX_OPEN_ROUTES);
  const recovery = new SourceRecovery({ directory, registry: () => registry, maxOpenRoutes,
    eligible: id => routable(id) && recommendedAdapters(registry).some(adapter => adapter.id === id),
    candidates: async () => {
      const ids: string[] = [];
      for (const adapter of recommendedAdapters(registry)) {
        const source = sources.sources.find(source => source.id === adapter.id);
        if (!source || !routable(source.id) || !sources.needsSignup(source.id)) continue;
        if (isDeclarativeAppAdapter(adapter) && await isDeclarativeAppBackedOff(adapter.id, directory)) continue;
        if (await configuredAccess(source) === false && sources.needsSignup(source.id)) ids.push(source.id);
      }
      return ids;
    },
    // Count routes that support client-owned function calls on ordinary requests.
    open: async () => (await Promise.all(sources.sources.filter(source => codingCapableRoute(source, directory)).map(live))).filter(Boolean).length,
    // Driver candidates follow docs/router.md: a coding harness on model grunt,
    // which the router sends to the best open tool-capable route, then each free
    // model an installed harness CLI reaches on its own.
    driver: async () => {
      const request = { model: 'grunt', cwd: directory, messages: [], tools: [], stream: false };
      const drivable = await Promise.all(sources.sources.filter(toolCapable).map(async source => await live(source) && sources.dispatchEligible(source.id, request)));
      // Loaded on demand: the daemon's model API never needs harness code.
      const { signupDriver } = await import('./harnesses.js');
      return signupDriver(port, { routed: drivable.some(Boolean), openCode: (await readDataSharingConsent(directory, ['opencode'])).includes('opencode') });
    },
    opening: id => { opening = id; reconcile(); },
    signedUp: (id, ok) => telemetry.signup(id, ok),
    settled: (id, reason) => sources.setSetupFailure(id, reason),
    notify: console.error });
  // Account acquisition is distinct from registry refresh, dispatch and daily
  // access maintenance. Read the explicit operator policy once at startup.
  const acquireAccounts = gruntEnv('BACKGROUND_ACCOUNT_ACQUISITION', env) !== '0';
  const triggerRecovery = () => { if (acquireAccounts) recovery.trigger(); };
  sources.setRecovery(triggerRecovery);
  sources.setRouteDropped(() => { if (acquireAccounts) void recovery.lowRoutes(); });
  let published: string | undefined;
  const sync = new RegistrySync({ directory, ...(env.GRUNT_REGISTRY_URL ? { url: env.GRUNT_REGISTRY_URL } : {}),
    changed: current => {
      // A newer publication that changes a retired route's entry gives it a fresh try.
      // A weight-only change does not; every write rescales its tier's weights.
      const same = (adapter: Adapter) => {
        const previous = registry.adapters.find(item => item.id === adapter.id);
        return !!previous && isDeepStrictEqual({ ...previous, weight: 0 }, { ...adapter, weight: 0 });
      };
      if (published !== undefined && Date.parse(current.published) > Date.parse(published)) sources.unretire(current.adapters.filter(adapter => !same(adapter)).map(adapter => adapter.id));
      published = current.published;
      registry = current;
      sources.adopt(current);
      void refreshDataSharingConsent(directory, env, registryDataSharingPolicies(current)).catch(() => {});
    },
    exchange: () => telemetry.exchange(),
    synced: () => { if (acquireAccounts) recovery.synced(); }, notify: console.error
  });
  const maintenance = createSourceMaintenance(sources, { directory, registry: () => registry, refreshSession, notify: console.error });
  // Registry downloads and access maintenance are independent. Only the route
  // pass above provisions accounts, in the background, after each registry sync
  // and when no source can answer. It never hands a browser to a person.
  // Renew approvals for changed provider policies before serving, so an update never turns a route off.
  const consent = sync.load().then(() => refreshDataSharingConsent(directory, env, registryDataSharingPolicies(registry))).then(renewed => {
    if (renewed.length) console.error(`Data sharing on: ${renewed.join(', ')}. Off: ${DATA_SHARING_OPT_OUT}`);
  }).catch(() => console.error('Data-sharing approvals could not be renewed; rerun usegrunt setup'));
  const ready = Promise.all([diagnosticReady, routingHistory.ready, consent]).then(() => refreshSession());
  let readiness: NonNullable<ObservationRuntime['readiness']> = 'starting';
  void ready.then(() => { readiness = 'ready'; }, () => { readiness = 'failed'; });
  void ready.then(() => sync.start()).catch(() => console.error('Registry sync could not start; using the bundled list'));
  void ready.then(() => maintenance.start()).catch(() => console.error('Daily maintenance could not start; run usegrunt setup to repair local configuration'));
  const redactedSettings = ['OPENCODE_URL', 'CONFIG_DIR']
    .filter(name => gruntEnv(name, env) !== undefined);
  if (env.GRUNT_REGISTRY_URL) redactedSettings.push('REGISTRY_URL');
  const app = createLocalApp(sources, { port, log: cwd => console.error(`grunt working directory: ${cwd}`),
    observation: () => ({ version: runtimeVersion, startedAt, port, readiness, config: {
      telemetry: telemetry.enabled, backgroundAccountAcquisition: acquireAccounts,
      registry: env.GRUNT_REGISTRY_URL ? 'custom' : 'bundled_and_public', redactedSettings
    } }) });
  const server = serve({ fetch: async request => {
    const path = new URL(request.url).pathname;
    // Observation stays available during startup and stalled session refreshes.
    if (request.method !== 'GET' || path !== OBSERVATION_PATH) {
      await ready;
      // Status still shows setup progress without starting the next acquisition pass.
      if (request.method !== 'GET' || path !== '/v1/diagnostics/metrics') {
        const passive = request.method === 'GET' && path === '/v1/status' && request.headers.get('X-Grunt-Setup-Complete') !== '1';
        await refreshSession(passive);
      }
    }
    return app.fetch(request);
  }, hostname: HOST, port }, () => console.error(`grunt model API: http://${HOST}:${port}/v1`));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await Promise.all([maintenance.close(), sync.close(), recovery.close()]); await sources.close(); await routingHistory.close(); await diagnosticReady; await diagnostics?.close(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (typeof GRUNT_DAEMON_BUNDLE !== 'undefined') start();
  else if (process.argv[2] === 'update') {
    try {
      if (process.argv.length > 3) throw new Error('Usage: usegrunt update');
      const { updateRuntime } = await import('./update.js');
      const result = await updateRuntime({ notify: line => console.log(line) });
      console.log(`grunt updated to ${result.version}; ${result.active ? `daemon ready on port ${result.port}` : 'service remains stopped'}`);
    } catch (error) { console.error(error instanceof Error ? error.message : 'Could not update grunt'); process.exitCode = 1; }
  } else if (process.argv[2] === 'status') {
    const { statusCommand } = await import('./dashboard.js');
    const { HARNESSES } = await import('./harnesses.js');
    try { await statusCommand(process.argv.slice(3), { harnesses: HARNESSES }); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Could not read grunt status'); process.exitCode = 1; }
  } else if (process.argv[2] === 'ui' || process.argv[2] === 'dashboard') {
    try { const { uiCommand } = await import('./ui-server.js'); await uiCommand(process.argv.slice(3)); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Could not start the local Grunt UI'); process.exitCode = 1; }
  } else if (process.argv[2] === 'observe') {
    try { const { observeCommand } = await import('./observe-cli.js'); await observeCommand(process.argv.slice(3)); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Could not observe the local Grunt daemon'); process.exitCode = 1; }
  } else if (process.argv[2] === 'efficiency') {
    try { const { efficiencyCommand } = await import('./efficiency-cli.js'); await efficiencyCommand(process.argv.slice(3)); }
    catch { console.error('Grunt efficiency command failed; check arguments and local measurement availability.'); process.exitCode = 1; }
  } else if (process.argv[2] === 'execution-host') {
    try {
      const { executionHostCommand } = await import('./efficiency-host.js');
      await executionHostCommand(process.argv.slice(3));
    } catch (error) { console.error(error instanceof Error ? error.message : 'Grunt execution host failed'); process.exitCode = 1; }
  } else if (process.argv[2] === 'jobs') {
    console.error('Grunt background jobs were removed. Use your coding harness\'s own background tasks and subagents (Claude Code, Codex and OpenCode have them built in).');
    process.exitCode = 1;
  } else if (process.argv[2] === 'workers') {
    console.error('Grunt subworkers were removed. Use your coding harness\'s own subagents (Claude Code, Codex and OpenCode have them built in). Retained worker artifacts, if any, are no longer managed by Grunt.');
    process.exitCode = 1;
  } else if (process.argv[2] === 'vault') {
    try {
      const { vaultCommand } = await import('./vault-cli.js');
      await vaultCommand(process.argv.slice(3));
    } catch (error) { console.error(error instanceof Error ? error.message : 'Grunt vault command failed'); process.exitCode = 1; }
  } else if (process.argv[2] === 'apps') {
    try {
      const { appsCommand } = await import('./app-sandbox.js');
      await appsCommand(process.argv.slice(3));
    } catch (error) { console.error(error instanceof Error ? error.message : 'Grunt apps command failed'); process.exitCode = 1; }
  } else if (['--help', '-h'].includes(process.argv[2] ?? '')) {
    console.log('Usage: usegrunt [setup | update | add <provider> [--force] | apps <list|clean [<id>|--all]> | vault <list|set|export|remove> | status [--watch] [--json] [--port <port>] | ui [--port <port>] [--ui-port <port>] [--no-open] [--bind <ip> | --tailscale] [--snapshot <file.html>] | observe [--limit <N>] [--json] [--port <port>] | efficiency metrics [--port <port>] [--since <epoch-ms>] [--until <epoch-ms>] | execution-host <serve|tick|status> --config <private-policy.json>]\n\nRun setup to connect free sources, apps to inspect or clean sandboxed CLI apps, vault to manage direct local API keys, update to refresh the installed daemon, status --watch for the terminal view, or ui (alias dashboard) for the local web console.\nRun observe --help for request, attempt, and daemon diagnostics.');
  } else if (['setup', 'add'].includes(process.argv[2] ?? '') || (!process.argv[2] && basename(process.argv[1]) === 'usegrunt' && process.env.GRUNT_DAEMON !== '1')) {
    const { wizard } = await import('./wizard.js');
    try {
      await wizard(process.argv[2] === 'add' ? process.argv[3] ?? '' : undefined, undefined, { force: process.argv[2] === 'add' && process.argv.slice(4).includes('--force') });
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'grunt setup failed'); process.exitCode = 1; }
  } else if (!process.argv[2] || process.argv[2] === 'serve') start();
  else { console.error('Unknown grunt command. Run usegrunt --help.'); process.exitCode = 1; }
}
