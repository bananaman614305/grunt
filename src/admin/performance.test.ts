import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { projectAgentActivity } from './activity.js';
import { validateAdminEvent } from './types.js';

const now = 1794948372598;
const id = '11111111-1111-4111-8111-111111111111';
const workers = { active: [{ id, state: 'running', createdAt: now - 1000, mode: 'agent', turns: 4,
  toolCalls: 7, artifactAvailable: true, waitingForSource: true, code: 'ownership_violation',
  capabilities: { filesystem: true, commands: true, sandbox: 'bubblewrap' } }], queued: [], recent: [] };
const breakdown = { executionMs: 5000, inferenceMs: 5000, toolWaitMs: 5000, providerWaitMs: 5000,
  idleMs: 5000, blockedMs: 5000, unclassifiedMs: 5000 };
const window = { workingMs: 15000, downtimeMs: 20000, providerWaitMs: 5000, breakdown };
const utilization = { capacityMs: 10000, occupiedMs: 5000, sourceWaitMs: 5000, completed: 2, failed: 1 };
const checks = { successfulChecks: 2, failedChecks: 1, headLinkedChecks: 1 };
const work = { at: now, state: 'tool_wait', day: window, week: window,
  workerUtilization: { observedSince: now - 50000, day: utilization, week: utilization },
  delivery: { observedSince: now - 50000, day: checks, week: checks, playableDeployments: null } };
const activity = { version: 1, observedAt: now, phase: 'working', active: [], lastReply: null, issues: [], events: [], workers, work };
function helpers(expression: string): unknown {
  const module = new URL('../../site/admin/admin.js', import.meta.url).href;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const ui = await import(${JSON.stringify(module)}); console.log(JSON.stringify(${expression}));`], { encoding: 'utf8' }));
}

it('projects actual tool-using worker capabilities, failures, counters, and measured performance without private fields', () => {
  const result = projectAgentActivity({ ...activity, private: 'PRIVATE', workers: { ...workers, active: [
    { ...workers.active[0], task: 'PRIVATE', artifact: 'PRIVATE', command: 'PRIVATE',
      capabilities: { ...workers.active[0].capabilities, command: 'PRIVATE' } }
  ] } }, now);
  expect(result.work).toEqual(work);
  expect(result.workers).toEqual(workers);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(projectAgentActivity({ ...activity, workers: { ...workers, active: [{ ...workers.active[0], code: 'PRIVATE' }] } }, now).workers?.active[0].code).toBeUndefined();
});

it('rejects impossible or stale measurements rather than manufacturing utilization or milestone counts', () => {
  for (const invalid of [
    { ...work, at: now - 15001 },
    { ...work, day: { ...window, breakdown: { ...breakdown, inferenceMs: 10000 } } },
    { ...work, day: { ...window, breakdown: { ...breakdown, inferenceMs: 15000, idleMs: 0, unclassifiedMs: 0 } } },
    { ...work, workerUtilization: { ...work.workerUtilization, day: { ...utilization, sourceWaitMs: 6000 } } },
    { ...work, workerUtilization: { ...work.workerUtilization, day: { ...utilization, occupiedMs: 10001 } } },
    { ...work, delivery: { ...work.delivery, day: { ...checks, headLinkedChecks: 3 } } },
    { ...work, delivery: { ...work.delivery, playableDeployments: 5 } }
  ]) expect(() => projectAgentActivity({ ...activity, work: invalid }, now)).toThrow();
  expect(() => projectAgentActivity({ ...activity, workers: { ...workers, active: [workers.active[0], workers.active[0]] } }, now)).toThrow();
  expect(() => projectAgentActivity({ ...activity, workers: { ...workers, active: [{ ...workers.active[0], turns: -1 }] } }, now)).toThrow();
});

it('uses Adventure workers from the activity pool once per installation, and labels missing updates stale', () => {
  const overview = { instances: [{ id: 'chad', connected: true, snapshot: { workers: { active: [], queued: [], recent: [] } } }] };
  const feed = { instances: [{ instanceId: 'chad', receivedAt: now, activity }] };
  const result = helpers(`ui.homeWorkerInstallations(${JSON.stringify(overview)}, ${JSON.stringify(feed)}, ${now})`) as { connected: boolean; snapshot: { workers: unknown } }[];
  expect(result).toHaveLength(1);
  expect(result[0].snapshot.workers).toEqual(workers);
  expect(result[0].connected).toBe(true);
  expect(helpers(`ui.homeWorkerInstallations(${JSON.stringify(overview)}, ${JSON.stringify(feed)}, ${now + 20001})[0].connected`)).toBe(false);
});

function render(measurement: unknown, publications: unknown = null): unknown {
  return helpers(`(() => {
    class FixtureNode {
      children = []; value = '';
      set textContent(value) { this.value = String(value); }
      get textContent() { return [this.value, ...this.children.map(child => child.textContent)].join(' '); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      addEventListener() {}
    }
    globalThis.Node = FixtureNode;
    globalThis.document = {createElement: () => new FixtureNode(), createTextNode: text => {const n = new FixtureNode();n.textContent = text;return n;}};
    const totals = new FixtureNode();
    const el = {'home-uptime': new FixtureNode(), 'home-uptime-totals': totals, 'home-uptime-freshness': new FixtureNode()};
    ui.AdminConsole.prototype.renderWorkUptime.call({el}, ${JSON.stringify(measurement)}, ${now}, ${JSON.stringify(publications)});
    return totals.textContent;
  })()`);
}

it('renders measured categories, subworker occupancy, and actual check jobs while keeping playable releases unknown', () => {
  const output = render(work);
  expect(output).toContain('Where time goes');
  expect(output).toContain('Tool and job waits');
  expect(output).toContain('Inference includes model processing and generation');
  expect(output).toContain('50.0%');
  expect(output).toContain('Revisions checked');
  expect(output).toContain('not inferred feature completion');
  expect(output).toContain('Published builds: not measured');
});

it('keeps new metric coverage unknown for earlier activity snapshots', () => {
  const output = render({ at: now, state: 'working', day: { workingMs: 5000, downtimeMs: 0, providerWaitMs: 0 }, week: { workingMs: 5000, downtimeMs: 0, providerWaitMs: 0 } });
  expect(output).toContain('Detailed time classification has not been reported yet');
  expect(output).toContain('Worker utilization has not been measured yet');
  expect(output).toContain('Check-job outcomes have not been reported yet');
  expect(output).toContain('Published builds: not measured');
});


it('shows tool-using worker counters and actionable failure codes without mistaking workspace preparation for a source wait', () => {
  const output = helpers(`(() => {
    class FixtureNode {
      children = []; value = ''; dateTime = '';
      set textContent(value) { this.value = String(value); }
      get textContent() { return [this.value, ...this.children.map(child => child.textContent)].join(' '); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      addEventListener() {}
    }
    globalThis.Node = FixtureNode;
    globalThis.document = {createElement: () => new FixtureNode()};
    const el = {'home-workers': new FixtureNode(), 'home-worker-list': new FixtureNode(), 'home-worker-counts': new FixtureNode()};
    const activity = ${JSON.stringify({ instances: [{ instanceId: 'chad', receivedAt: now, activity }] })};
    activity.instances[0].activity.workers.active[0].waitingForSource = false;
    ui.AdminConsole.prototype.renderHomeWorkers.call({el,overview:{},activity}, ${now});
    return el['home-worker-list'].textContent;
  })()`);
  expect(output).toContain('Tool-using worker');
  expect(output).toContain('4 turns');
  expect(output).toContain('7 tool calls');
  expect(output).toContain('File ownership conflict');
  expect(output).not.toContain('Waiting for a source');
});


it('accepts bounded deployment receipts only with explicit partial coverage, safe revision hashes and consistent windows', () => {
  const publications = { observedAt: now, coverage: 'partial', day: { builds: 2, revisions: 1 }, week: { builds: 3, revisions: 2 }, latest: { at: now - 1000, head: 'a'.repeat(40) } };
  expect(projectAgentActivity({ ...activity, project: { milestones: [], publications } }, now).project?.publications).toEqual(publications);
  expect(render(work, publications)).toContain('Counts are lower bounds, not proof of playability');
  expect(render(work, publications)).toContain('Latest published revision aaaaaaa');
  for (const invalid of [{ ...publications, coverage: 'complete' }, { ...publications, latest: { at: now, head: 'PRIVATE' } },
    { ...publications, observedAt: now - 3600001 }, { ...publications, day: { builds: 4, revisions: 1 } }]) {
    expect(() => projectAgentActivity({ ...activity, project: { milestones: [], publications: invalid } }, now)).toThrow();
  }
});


it('projects trusted diagnostic actor context without attributing historical or ordinary client requests to the main worker', () => {
  const event = { version: 1, id, requestId: id, at: now, type: 'request.start', kind: 'user' };
  expect(validateAdminEvent(event, now)).not.toHaveProperty('actor');
  expect(validateAdminEvent({ ...event, actor: 'client' }, now).actor).toBe('client');
  expect(validateAdminEvent({ ...event, actor: 'worker', workerId: id, task: 'PRIVATE' }, now)).toEqual({ ...event, actor: 'worker', workerId: id });
  for (const fields of [{ actor: 'main' }, { workerId: id }, { actor: 'client', workerId: id }, { actor: 'worker', workerId: 'PRIVATE' }]) {
    expect(() => validateAdminEvent({ ...event, ...fields }, now)).toThrow();
  }
});
