export type Kind = "chat" | "code" | "research" | "writing";
export type Status = "queued" | "running" | "done" | "failed" | "cancelled";
export type Task = {
  id: string; person: string; title: string; brief: string; kind: Kind; status: Status;
  model: string | null; route_reason: string | null; result: string | null; error: string | null;
  created_at: number; updated_at: number;
};
export type Message = { id: string; person: string; role: "user" | "assistant"; text: string; ts: number };
export type Note = { text: string; ts: number };
export type Call = {
  model: string; kind: Kind; tokens_in: number; tokens_out: number; latency_ms: number;
  outcome: "ok" | "429" | "error"; cost: number; ts: number;
};
export type ModelPrior = {
  model: string; quality: Record<Kind, number>; inputUsdPerM: number; outputUsdPerM: number;
  contextLength: number; reliability?: number | undefined; latencyMs?: number | undefined;
};
export type AgentConfig = { whitelist?: ModelPrior[] | undefined };
export type AgentEvent = { type: "message"; data: Message } | { type: "task"; data: Omit<Task, "brief" | "result" | "person"> };
