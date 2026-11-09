import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { personId } from "./agent.js";
import type { MiloAgent } from "./agent.js";
export { MiloAgent, personId, workerMessages } from "./agent.js";
export { pick, DEFAULT_WHITELIST } from "./router.js";
export type { AgentConfig, ModelPrior } from "./types.js";

export function agentRoutes(agent: MiloAgent) {
  const app = new Hono<{ Variables: { key: string; person: string } }>();
  app.get("/", c => c.redirect("/chat"));
  app.get("/health", c => c.json({ status: "ok" }));
  app.get("/chat", c => c.html(readFileSync(new URL("./chat.html", import.meta.url), "utf8")));
  app.use("/agent/*", async (c, next) => {
    const key = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!key) return c.json({ error: "An OpenRouter Bearer key is required." }, 401);
    c.set("key", key); c.set("person", personId(key));
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/agent/*", bodyLimit({ maxSize: 32_768, onError: c => c.json({ error: "Message too large. Use at most 20,000 characters." }, 413) }));
  app.get("/agent/state", async c => c.json(await agent.store.state(c.get("person"))));
  app.post("/agent/messages", async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Send JSON with a text field." }, 400); }
    const text = typeof body === "object" && body !== null && "text" in body ? body.text : null;
    if (typeof text !== "string" || !text.trim() || text.length > 20_000) return c.json({ error: "Message must contain between 1 and 20,000 characters." }, 400);
    return c.json(await agent.message(c.get("key"), text.trim()));
  });
  app.post("/agent/tasks/:id/cancel", async c => {
    const task = await agent.cancel(c.get("person"), c.req.param("id"));
    return task ? c.json({ task }) : c.json({ error: "Job not found." }, 404);
  });
  app.get("/agent/events", c => {
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async stream => {
      let finish!: () => void;
      const closed = new Promise<void>(resolve => { finish = resolve; });
      let writing = Promise.resolve();
      const unsubscribe = agent.subscribe(c.get("person"), event => {
        writing = writing.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) })).catch(() => { finish(); });
      });
      stream.onAbort(finish);
      const heartbeat = setInterval(() => { writing = writing.then(() => stream.write(": keepalive\n\n")).then(() => {}).catch(() => { finish(); }); }, 15_000);
      try { await stream.write(": connected\n\n"); await closed; }
      finally { clearInterval(heartbeat); unsubscribe(); }
    });
  });
  app.onError((_err, c) => c.json({ error: "Milo couldn't complete this request. Please try again." }, 500));
  return app;
}
