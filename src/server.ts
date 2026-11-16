import { gruntEnv } from './brand.js';
import { serve } from "@hono/node-server";
import { GruntAgent, defaultAgentDb } from "./agent.js";
import { loadConfig } from "./config.js";
import { agentRoutes } from "./index.js";
import { DotsStore } from "./dots-store.js";
import { dotsRelay } from "./dots-relay.js";
import { registryRoutes } from './registry-routes.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
const agent = await GruntAgent.open({ ...loadConfig(gruntEnv('CONFIG')), dbUrl: gruntEnv('DB') ?? defaultAgentDb() });
const dotsStore = new DotsStore(agent.store.db);
await dotsStore.init();
const relay = dotsRelay(dotsStore, { origin: gruntEnv('PUBLIC_URL') ?? 'https://api.grunt.run' });
const stopRelay = relay.start();
const app = relay.app.route('/', registryRoutes()).route('/', agentRoutes(agent));
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
