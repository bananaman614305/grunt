import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';

vi.mock('@clack/prompts', () => Object.fromEntries(['text', 'password', 'confirm', 'select', 'multiselect'].map(name => [name, vi.fn(() => { throw new Error(`Unexpected prompt: ${name}`); })])));
afterEach(() => { vi.restoreAllMocks(); });
const input = { service: 'groq', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' } as const;

it.each(['low_confidence', 'no_progress', 'needs_value', 'stuck'])('finishes uncertain %s signup without asking when a key was captured', async status => {
  const squire = new BrowserSquire();
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([{ service: 'groq', reference: 'vault://test', field_names: ['api_key'] }]);
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status, session_id: 'owned-tab', options: { DONE: 'The goal is complete' } } : {});
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'owned-tab', outcome: 'result', summary: 'grunt provider key stored in user vault' });
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  await squire.close();
});

it.each(['low_confidence', 'no_progress', 'needs_value', 'stuck', 'failed'])('skips %s without a captured key and never prints internal goals', async status => {
  const squire = new BrowserSquire();
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  const log = vi.spyOn(console, 'log');
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status, field: 'email verification', session_id: 'owned-tab', options: { DONE: 'The goal is complete' } } : {});
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'dropped' } });
  expect(log).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'owned-tab', outcome: 'none' });
  await squire.close();
});

it.each(['rejected', 'refused'])('keeps a provider %s authoritative even when a key exists', async status => {
  const squire = new BrowserSquire();
  const credentials = vi.spyOn(squire.credentials, 'list');
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status, session_id: 'owned-tab', reason: 'Provider denied automated signup' } : {});
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'dropped' }, reason: 'provider refused' });
  expect(credentials).not.toHaveBeenCalled();
  await squire.close();
});
