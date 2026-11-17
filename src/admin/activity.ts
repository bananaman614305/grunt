import { AdminDataError, isAdminSourceId } from './types.js';

const phases = ['starting', 'working', 'checkpoint', 'waiting_for_free_pool', 'stopped', 'offline'] as const;
const errors = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'] as const;
const toolNames = ['read', 'write', 'edit', 'bash'] as const;

type Provider = { source: string; model?: string };
type Event = { at: number; kind: 'progress'; text: string }
  | { at: number; kind: 'tool'; tool: typeof toolNames[number]; failed: boolean };

export interface AgentActivity {
  version: 1;
  observedAt: number;
  phase: typeof phases[number];
  active: Provider[];
  lastReply: (Provider & { at: number }) | null;
  issues: (Provider & { error: typeof errors[number] })[];
  events: Event[];
}

const unsafeText = /[<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|https?:\/\/|vault:|\/(?:home|tmp|worker|root|proc|etc)\/|file:|\b(?:bearer|password|secret|credential|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|cookie|private[ _-]?key|authorization)\b|\b(?:sk-|gh[pousr]_|AKIA|GOCSPX-|AIza)[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[A-Za-z0-9_+/=-]{32,}/i;

function invalid(): never { throw new AdminDataError('invalid_activity'); }
function record(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
  return item as Record<string, unknown>;
}
function list<T>(item: unknown, limit: number, project: (row: unknown) => T): T[] {
  if (!Array.isArray(item) || item.length > limit) return invalid();
  return item.map(project);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid();
  return value as T;
}
function time(value: unknown, earliest: number, latest: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < earliest || value > latest) return invalid();
  return value;
}
function provider(value: unknown): Provider {
  const row = record(value);
  if (!isAdminSourceId(row.source)) return invalid();
  const model = row.model;
  if (model === undefined) return { source: row.source };
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+ -]{0,159}$/.test(model) || unsafeText.test(model)) return invalid();
  return { source: row.source, model };
}

export function projectAgentActivity(value: unknown, now: number): AgentActivity {
  const data = record(value);
  if (data.version !== 1) return invalid();
  const observedAt = time(data.observedAt, now - 120000, now + 5000);
  const recent = (value: unknown) => time(value, observedAt - 86400000, observedAt + 5000);
  const reply = data.lastReply === null ? null : record(data.lastReply);
  const events = list<Event | null>(data.events, 40, value => {
    const event = record(value);
    const at = recent(event.at);
    if (event.kind === 'tool' && typeof event.failed === 'boolean') {
      return { at, kind: 'tool', tool: oneOf(event.tool, toolNames), failed: event.failed };
    }
    if (event.kind !== 'progress' || typeof event.text !== 'string' || event.text.length > 400) return invalid();
    const text = event.text.trim();
    if (!text || unsafeText.test(text) || text.includes(String.fromCharCode(96))) return null;
    return { at, kind: 'progress', text };
  });
  return {
    version: 1, observedAt, phase: oneOf(data.phase, phases),
    active: list(data.active, 32, provider),
    lastReply: reply ? { ...provider(reply), at: recent(reply.at) } : null,
    issues: list(data.issues, 32, value => {
      const issue = record(value);
      return { ...provider(issue), error: oneOf(issue.error, errors) };
    }),
    events: events.filter((event): event is Event => event !== null).sort((a, b) => a.at - b.at)
  };
}

// Progress is deliberately separate from diagnostic storage and export.
export class AgentActivityFeed {
  private snapshots = new Map<string, { receivedAt: number; activity: AgentActivity }>();
  constructor(private now: () => number) {}
  private prune(now: number) {
    for (const [id, row] of this.snapshots) {
      if (row.receivedAt <= now - 120000 || row.activity.observedAt <= now - 120000) this.snapshots.delete(id);
    }
  }
  update(instanceId: string, value: unknown) {
    const now = this.now(), activity = projectAgentActivity(value, now);
    this.prune(now);
    const previous = this.snapshots.get(instanceId);
    if (!previous || previous.activity.observedAt < activity.observedAt) {
      this.snapshots.set(instanceId, { receivedAt: now, activity });
    }
  }
  read(instanceId?: string) {
    this.prune(this.now());
    return {
      instances: [...this.snapshots.entries()]
        .filter(([id]) => !instanceId || id === instanceId)
        .map(([id, row]) => ({ instanceId: id, ...row }))
    };
  }
}
