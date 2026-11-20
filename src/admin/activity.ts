import { AdminDataError, isAdminSourceId, projectAdminWorkers } from './types.js';
import type { AdminWorkers } from './types.js';

const phases = ['starting', 'working', 'checkpoint', 'waiting_for_free_pool', 'stopped', 'offline'] as const;
const errors = ['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'] as const;
const issueStates = ['available', 'limited', 'error', 'unavailable'] as const;
const toolNames = ['read', 'write', 'edit', 'bash'] as const;

type Provider = { source: string; model?: string };
type Event = { at: number; kind: 'progress'; text: string }
  | { at: number; kind: 'tool'; tool: typeof toolNames[number]; failed: boolean };
const milestoneStates = ['draft', 'review', 'merged', 'closed'] as const;
const workStates = ['working', 'provider_wait', 'between_cycles', 'starting', 'paused', 'offline', 'stalled', 'tool_wait', 'unknown'] as const;
const dayMs = 86400000;
const breakdownFields = ['executionMs', 'inferenceMs', 'toolWaitMs', 'providerWaitMs', 'idleMs', 'blockedMs', 'unclassifiedMs'] as const;
type WorkWindow = { workingMs: number; downtimeMs: number; providerWaitMs: number; breakdown?: Record<typeof breakdownFields[number], number> };
type WorkerWindow = { capacityMs: number; occupiedMs: number; sourceWaitMs: number; completed: number; failed: number };
type DeliveryWindow = { successfulChecks: number; failedChecks: number; headLinkedChecks: number };
interface WorkActivity {
  at: number;
  state: typeof workStates[number];
  day: WorkWindow;
  week: WorkWindow;
  workerUtilization?: { observedSince: number; day: WorkerWindow; week: WorkerWindow };
  delivery?: { observedSince: number; day: DeliveryWindow; week: DeliveryWindow; playableDeployments: null };
}
interface PublicationActivity {
  observedAt: number;
  coverage: 'partial';
  day: { builds: number; revisions: number };
  week: { builds: number; revisions: number };
  latest?: { at: number; head: string };
}
interface ProjectActivity {
  publications?: PublicationActivity;
  checkpoint?: { at: number; summary?: string; next: string[] };
  milestones: { at: number; number: number; title: string; status: typeof milestoneStates[number] }[];
}

export interface AgentActivity {
  version: 1;
  observedAt: number;
  phase: typeof phases[number];
  active: Provider[];
  lastReply: (Provider & { at: number }) | null;
  issues: (Provider & { error: typeof errors[number]; state?: typeof issueStates[number] })[];
  events: Event[];
  project?: ProjectActivity;
  work?: WorkActivity;
  workers?: AdminWorkers;
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

function projectedProse(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length > limit) return invalid();
  const text = value.trim();
  return text && !unsafeText.test(text) && !text.includes(String.fromCharCode(96)) ? text : null;
}

function projectTimeline(value: unknown, observedAt: number): ProjectActivity {
  const data = record(value);
  const milestones = list<ProjectActivity['milestones'][number] | null>(data.milestones, 4, value => {
    const row = record(value), title = projectedProse(row.title, 160);
    if (!title) return null;
    return { title, number: time(row.number, 1, 1000000), at: time(row.at, 1, observedAt + 5000),
      status: oneOf(row.status, milestoneStates) };
  }).filter((row): row is ProjectActivity['milestones'][number] => row !== null).sort((a, b) => b.at - a.at);
  const publications = data.publications === undefined ? undefined : projectPublications(data.publications, observedAt);
  if (data.checkpoint === undefined) return { milestones, ...(publications ? { publications } : {}) };
  const checkpoint = record(data.checkpoint);
  const summary = checkpoint.summary === undefined ? null : projectedProse(checkpoint.summary, 400);
  const next = list(checkpoint.next, 3, step => projectedProse(step, 400)).filter((step): step is string => step !== null);
  const at = time(checkpoint.at, observedAt - 30 * 86400000, observedAt + 5000);
  return { milestones, ...(publications ? { publications } : {}), ...(summary || next.length ? { checkpoint: { at, ...(summary ? { summary } : {}), next } } : {}) };
}

function projectPublications(value: unknown, observedAt: number): PublicationActivity {
  const row = record(value);
  const window = (value: unknown) => {
    const raw = record(value), builds = time(raw.builds, 0, 256);
    return { builds, revisions: time(raw.revisions, 0, builds) };
  };
  const result: PublicationActivity = { observedAt: time(row.observedAt, observedAt - 3600000, observedAt + 5000),
    coverage: oneOf(row.coverage, ['partial']), day: window(row.day), week: window(row.week) };
  if (result.day.builds > result.week.builds || result.day.revisions > result.week.revisions) return invalid();
  if (row.latest !== undefined) {
    const latest = record(row.latest);
    if (typeof latest.head !== 'string' || !/^[a-f0-9]{40}$/.test(latest.head)) return invalid();
    result.latest = { at: time(latest.at, 1, observedAt + 5000), head: latest.head };
  }
  return result;
}

function projectWork(value: unknown, observedAt: number): WorkActivity {
  const data = record(value);
  const window = (value: unknown, duration: number): WorkWindow => {
    const row = record(value);
    const workingMs = time(row.workingMs, 0, duration);
    const downtimeMs = time(row.downtimeMs, 0, duration - workingMs);
    const result: WorkWindow = { workingMs, downtimeMs, providerWaitMs: time(row.providerWaitMs, 0, downtimeMs) };
    if (row.breakdown !== undefined) {
      const raw = record(row.breakdown), breakdown = Object.fromEntries(breakdownFields.map(key => [key, time(raw[key], 0, workingMs + downtimeMs)])) as Record<typeof breakdownFields[number], number>;
      if (Object.values(breakdown).reduce((total, value) => total + value, 0) !== workingMs + downtimeMs
          || breakdown.providerWaitMs > result.providerWaitMs
          || breakdown.executionMs + breakdown.inferenceMs > workingMs
          || breakdown.toolWaitMs + breakdown.providerWaitMs + breakdown.idleMs + breakdown.blockedMs > downtimeMs) return invalid();
      result.breakdown = breakdown;
    }
    return result;
  };
  const result: WorkActivity = { at: time(data.at, observedAt - 15000, observedAt + 5000), state: oneOf(data.state, workStates),
    day: window(data.day, dayMs), week: window(data.week, 7 * dayMs) };
  if (data.workerUtilization !== undefined) {
    const raw = record(data.workerUtilization);
    const workerWindow = (value: unknown, duration: number): WorkerWindow => {
      const row = record(value), capacityMs = time(row.capacityMs, 0, duration * 2), occupiedMs = time(row.occupiedMs, 0, capacityMs);
      return { capacityMs, occupiedMs, sourceWaitMs: time(row.sourceWaitMs, 0, occupiedMs), completed: time(row.completed, 0, 1000000), failed: time(row.failed, 0, 1000000) };
    };
    result.workerUtilization = { observedSince: time(raw.observedSince, 1, result.at), day: workerWindow(raw.day, dayMs), week: workerWindow(raw.week, dayMs * 7) };
  }
  if (data.delivery !== undefined) {
    const raw = record(data.delivery);
    const deliveryWindow = (value: unknown): DeliveryWindow => {
      const row = record(value), successfulChecks = time(row.successfulChecks, 0, 1000000);
      return { successfulChecks, failedChecks: time(row.failedChecks, 0, 1000000), headLinkedChecks: time(row.headLinkedChecks, 0, successfulChecks) };
    };
    if (raw.playableDeployments !== null) return invalid();
    result.delivery = { observedSince: time(raw.observedSince, 1, result.at), day: deliveryWindow(raw.day), week: deliveryWindow(raw.week), playableDeployments: null };
  }
  return result;
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
    const text = projectedProse(event.text, 400);
    return text ? { at, kind: 'progress', text } : null;
  });
  return {
    version: 1, observedAt, phase: oneOf(data.phase, phases),
    active: list(data.active, 32, provider),
    lastReply: reply ? { ...provider(reply), at: recent(reply.at) } : null,
    issues: list(data.issues, 32, value => {
      const issue = record(value);
      return { ...provider(issue), error: oneOf(issue.error, errors),
        ...(issue.state === undefined ? {} : { state: oneOf(issue.state, issueStates) }) };
    }),
    events: events.filter((event): event is Event => event !== null).sort((a, b) => a.at - b.at),
    ...(data.project === undefined ? {} : { project: projectTimeline(data.project, observedAt) }),
    ...(data.work === undefined ? {} : { work: projectWork(data.work, observedAt) }),
    ...(data.workers === undefined ? {} : { workers: projectAdminWorkers(data.workers, observedAt) })
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
