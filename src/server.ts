import { gruntEnv } from './brand.js';
import { serve } from "@hono/node-server";
import { GruntAgent, defaultAgentDb } from "./agent.js";
import { loadConfig } from "./config.js";
import { agentRoutes } from "./index.js";
import { DotsStore } from "./dots-store.js";
import { dotsRelay } from "./dots-relay.js";
import { registryRoutes } from './registry-routes.js';
import { AdminStore } from './admin/store.js';
import { adminRoutes } from './admin/routes.js';
import { RegistryStore } from './registry-store.js';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
const agent = await GruntAgent.open({ ...loadConfig(gruntEnv('CONFIG')), dbUrl: gruntEnv('DB') ?? defaultAgentDb() });
const dotsStore = new DotsStore(agent.store.db);
await dotsStore.init();
const relay = dotsRelay(dotsStore, { origin: gruntEnv('PUBLIC_URL') ?? 'https://api.grunt.run' });
const stopRelay = relay.start();
const adminStore = new AdminStore(agent.store.db);
let adminReady = true;
try { await adminStore.init(); }
catch { adminReady = false; console.error('grunt admin storage is unavailable.'); }
let registryStore: RegistryStore | undefined = new RegistryStore(agent.store.db);
try { await registryStore.init(); }
catch { registryStore = undefined; console.error('grunt registry storage is unavailable.'); }
const adminAssets = async (name: 'index.html' | 'admin.js' | 'admin.css' | 'grunt.svg' | 'favicon.svg') => {
  const icon = name === 'grunt.svg' || name === 'favicon.svg';
  const packaged = new URL(icon ? `./${name}` : `./admin-public/${name}`, import.meta.url);
  try { return await readFile(packaged, 'utf8'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    return readFile(new URL(icon ? `../site/${name}` : `../site/admin/${name}`, import.meta.url), 'utf8');
  }
};
const app = relay.app.route('/', adminRoutes(adminStore, { ready: adminReady, assets: adminAssets })).route('/', registryRoutes(registryStore ? { store: registryStore } : {})).route('/', agentRoutes(agent));
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`grunt is listening on port ${port}. Open /chat.`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if ("closeAllConnections" in server) server.closeAllConnections();
  server.close();
  stopRelay();
  await agent.close();
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
