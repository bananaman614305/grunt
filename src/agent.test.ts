import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterClient } from "./openrouter.js";
import { GruntAgent, personId } from "./agent.js";
import { agentRoutes } from "./index.js";
import type { AgentEvent } from "./types.js";

const KEY = "sk-or-v1-fake-proof-key";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const PERSON = personId(KEY);
const agents: GruntAgent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map(a => a.close())); });
const response = (content: string | null, tool_calls: unknown[] = []) => Response.json({ choices: [{ message: { content, tool_calls } }], usage: { prompt_tokens: 20, completion_tokens: 30 } });
const tool = (name: string, args: object) => ({ type: "function", function: { name, arguments: JSON.stringify(args) } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 2000;
  while (!await predicate()) { if (Date.now() > end) throw new Error("Condition did not arrive"); await new Promise(r => setTimeout(r, 5)); }
}
class Fake {
  requests: Record<string, unknown>[] = [];
  held = deferred<Response>();
  workerStarted = false;
  worker: (body: Record<string, unknown>, signal?: AbortSignal | null) => Response | Promise<Response> = (_body, signal) => new Promise((resolve, reject) => {
    this.held.promise.then(resolve, reject);
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  fetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); this.requests.push(body);
    const messages = body.messages as { role: string; content: string }[];
    const system = messages[0]!.content;
    if (system.startsWith("Complete Grunt")) { this.workerStarted = true; return this.worker(body, init?.signal); }
    if (system.includes("job just finished")) return response("Your plan is ready. I kept it short and used TypeScript. Read the full result in Jobs.");
    const last = messages.at(-1)!.content;
    if (last.includes("remember")) return response("Got it.", [tool("remember", { fact: "I write TypeScript; keep answers short." })]);
    if (last.includes("plan")) return response("On it.", [tool("dispatch", { title: "Launch plan", brief: "Write a short one-page launch plan for a TypeScript app.", kind: "writing" })]);
    return response("Hello! You can keep chatting while I work.");
  };
}
async function setup(fake = new Fake(), dbUrl = ":memory:") {
  const agent = await GruntAgent.open({ dbUrl, client: new OpenRouterClient({ fetch: fake.fetch }) }); agents.push(agent);
  const app = agentRoutes(agent);
  const send = (text: string, headers = AUTH) => app.request("/agent/messages", { method: "POST", headers, body: JSON.stringify({ text }) });
  return { agent, app, send, fake };
}

describe("Grunt chat and background jobs", () => {
  it("returns an immediate dispatch response and answers follow-ups while the worker is unresolved", async () => {
    const { send, fake, agent } = await setup();
    const initial = await Promise.race([send("write a plan"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("HTTP waited for worker")), 500))]);
    expect(initial.status).toBe(200);
    const data = await initial.json(); expect(data.reply).toContain("On it"); expect(data.dispatched).toHaveLength(1);
    await until(() => fake.workerStarted);
    for (const text of ["hello", "how are you", "still here"]) expect((await (await send(text)).json()).reply).toContain("keep chatting");
    expect((await agent.store.tasks(PERSON))[0]!.status).toBe("running");
    fake.held.resolve(response("A complete launch plan"));
    await until(async () => (await agent.store.messages(PERSON)).some(m => m.text.includes("Your plan is ready")));
  });
  it("publishes a completed result only as a Grunt assistant message on the authenticated SSE stream", async () => {
    const { app, send, fake } = await setup();
    const stream = await app.request("/agent/events", { headers: AUTH });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let wire = decoder.decode((await reader.read()).value);
    await send("write a plan"); await until(() => fake.workerStarted);
    fake.held.resolve(response("PRIVATE WORKER OUTPUT"));
    while (!wire.includes("Your plan is ready")) wire += decoder.decode((await reader.read()).value);
    expect(wire).toContain('"role":"assistant"');
    expect(wire).not.toContain("PRIVATE WORKER OUTPUT");
    expect(wire).not.toContain("event: worker");
    const state = await (await app.request("/agent/state", { headers: AUTH })).json();
    expect(state.tasks[0].result).toBe("PRIVATE WORKER OUTPUT");
    await reader.cancel();
  });
  it("gives the worker only the brief and durable notes, never prior chat", async () => {
    const { send, fake } = await setup();
    await send("remember I write TypeScript, keep answers short");
    await send("MY PRIVATE CHAT HISTORY"); await send("write a plan");
    await until(() => fake.workerStarted);
    const body = fake.requests.find(b => JSON.stringify(b).includes("Complete Grunt"))!;
    const input = JSON.stringify(body);
    expect(input).toContain("Write a short one-page launch plan");
    expect(input).toContain("I write TypeScript; keep answers short.");
    expect(input).not.toContain("MY PRIVATE CHAT HISTORY");
    expect(input).not.toContain(KEY); expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("max_tokens");
  });
  it.each([429, 503, 504])("retries a failed worker once on the next-best whitelisted model (%s)", async status => {
    const fake = new Fake(); let calls = 0;
    fake.worker = () => ++calls === 1 ? new Response(null, { status }) : response("Retried plan");
    const { send, agent } = await setup(fake);
    await send("write a plan");
    await until(async () => (await agent.store.tasks(PERSON))[0]?.status === "done");
    const workers = fake.requests.filter(b => JSON.stringify(b).includes("Complete Grunt"));
    expect(workers).toHaveLength(2); expect(workers[0]!.model).not.toBe(workers[1]!.model);
    expect((await agent.store.calls()).some(c => c.outcome === (status === 429 ? "429" : "error"))).toBe(true);
  });
  it("cancels an in-flight worker, isolates people, and never emits a completion after cancellation", async () => {
    const { send, app, agent, fake } = await setup();
    const events: AgentEvent[] = []; agent.subscribe(PERSON, e => events.push(e));
    const { dispatched } = await (await send("write a plan")).json(); await until(() => fake.workerStarted);
    const path = `/agent/tasks/${dispatched[0].id}/cancel`;
    expect((await app.request(path, { method: "POST", headers: { authorization: "Bearer another-person" } })).status).toBe(404);
    expect((await (await app.request("/agent/state", { headers: { authorization: "Bearer another-person" } })).json()).tasks).toHaveLength(0);
    expect((await app.request(path, { method: "POST", headers: AUTH })).status).toBe(200);
    fake.held.resolve(response("Should never appear"));
    await new Promise(r => setTimeout(r, 30));
    expect((await agent.store.tasks(PERSON))[0]!.status).toBe("cancelled");
    expect(events.filter(e => e.type === "message")).toHaveLength(1);
  });
  it("caps workers globally and per person and starts the next job after cancellation", async () => {
    const { send, fake, app } = await setup();
    for (let n = 0; n < 4; n++) await send("write a plan");
    const other = { ...AUTH, authorization: "Bearer other-person" };
    for (let n = 0; n < 3; n++) await send("write a plan", other);
    const workerCount = () => fake.requests.filter(b => JSON.stringify(b).includes("Complete Grunt")).length;
    await until(() => workerCount() === 3); await new Promise(r => setTimeout(r, 15)); expect(workerCount()).toBe(3);
    const state = await (await app.request("/agent/state", { headers: AUTH })).json();
    expect(state.tasks.filter((t: {status: string}) => t.status === "running")).toHaveLength(2);
    const task = state.tasks.find((t: {status: string}) => t.status === "running");
    await app.request(`/agent/tasks/${task.id}/cancel`, { method: "POST", headers: AUTH });
    await until(() => workerCount() === 4);
  });
  it("marks restart-interrupted jobs failed and stores no key material, including a pasted key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grunt-agent-"));
    try {
      const url = `file:${directory}/agent.db`;
      const { agent, send, fake } = await setup(new Fake(), url);
      await send(`hello ${KEY}`); await send("remember TypeScript");
      const task = await agent.store.dispatch(PERSON, "Interrupted", "work", "writing");
      await agent.store.update(PERSON, task.id, { status: "running" });
      agents.splice(agents.indexOf(agent), 1); await agent.close();
      const restarted = await GruntAgent.open({ dbUrl: url, client: new OpenRouterClient({ fetch: fake.fetch }) }); agents.push(restarted);
      expect((await restarted.store.task(PERSON, task.id))!.status).toBe("failed");
      expect((await restarted.store.notes(PERSON))[0]!.text).toContain("TypeScript");
      expect((await readFile(join(directory, "agent.db"))).includes(Buffer.from(KEY))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("sends a proactive failure update after bounded retries and records sanitized errors", async () => {
    const fake = new Fake(); fake.worker = () => new Response(KEY, { status: 503 });
    const { send, agent } = await setup(fake);
    await send("write a plan");
    await until(async () => (await agent.store.messages(PERSON)).length === 3);
    const state = await agent.store.state(PERSON);
    expect(state.tasks[0]!.status).toBe("failed");
    expect(state.tasks[0]!.error).toContain("503");
    expect(state.messages.at(-1)!.role).toBe("assistant");
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(fake.requests.filter(b => JSON.stringify(b).includes("job just finished"))).toHaveLength(1);
  });
  it("serves the new root and health routes while the former API is absent", async () => {
    const { app } = await setup();
    const root = await app.request("/");
    expect(root.status).toBe(302); expect(root.headers.get("location")).toBe("/chat");
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/v1/models", { headers: AUTH })).status).toBe(404);
  });

  it("validates authentication and input without invoking the model", async () => {
    const { app, send, fake } = await setup();
    expect((await app.request("/chat")).status).toBe(200);
    expect((await app.request("/agent/state")).status).toBe(401);
    expect((await send(" ")).status).toBe(400);
    expect((await send("x".repeat(20001))).status).toBe(400);
    expect((await send("x".repeat(33000))).status).toBe(413);
    expect(fake.requests).toHaveLength(0);
  });
});
