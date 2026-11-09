import { serve } from "@hono/node-server";
import { MiloAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { agentRoutes } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
const agent = await MiloAgent.open({ ...loadConfig(process.env.MILO_CONFIG), dbUrl: process.env.MILO_DB ?? "file:/data/milo.db" });
const app = agentRoutes(agent);
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`Milo is listening on port ${port}. Open /chat.`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if ("closeAllConnections" in server) server.closeAllConnections();
  server.close();
  await agent.close();
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
