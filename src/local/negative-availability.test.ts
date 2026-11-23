import { expect, it, vi } from 'vitest';
import { SourceAvailability } from './source-availability.js';
import { SourceStatus } from './source-status.js';
import { SourceError } from './source.js';
import type { Source } from './source.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const source = (): Source => ({ id: 'fixture', available: vi.fn(async () => false),
  healthCheck: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'fixture' })) });

it('bounds serial negative metadata checks across models/recovery and routing admission', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now), admission = new SourceAvailability(status);
  // Reproduce the ordinary models/recovery metadata path once per second.
  for (let second = 0; second < 60; second++) {
    now = second * 1000;
    expect(await status.available(fixture)).toBe(false);
    // The routing path must honor the same negative observation, not add a second window.
    expect(admission.peek(fixture.id)).toBe(false);
    expect(admission.start([fixture])).toBe(0);
  }
  expect(fixture.available).toHaveBeenCalledTimes(2);
  now = 60000;
  expect(admission.peek(fixture.id)).toBeUndefined();
  expect(admission.start([fixture])).toBe(1); await turn();
  expect(fixture.available).toHaveBeenCalledTimes(3);
  await admission.close();
  expect(fixture.complete).not.toHaveBeenCalled();
});

it('suppresses repeated failed availability transports without retaining private errors', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now);
  vi.mocked(fixture.available).mockRejectedValue(new Error('private upstream error'));
  await expect(status.available(fixture)).rejects.toThrow('private upstream error');
  now = 10000;
  expect(await status.available(fixture)).toBe(false);
  expect(fixture.available).toHaveBeenCalledOnce();
  now = 30000;
  await expect(status.available(fixture)).rejects.toThrow('private upstream error');
  expect(fixture.available).toHaveBeenCalledTimes(2);
});

it('does not cache positive admission or bypass fresh completion authorization', async () => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  vi.mocked(fixture.available).mockResolvedValue(true);
  expect(await status.available(fixture)).toBe(true);
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(2);
  // A later guard failure must remain authoritative even after positive metadata.
  vi.mocked(fixture.complete).mockRejectedValue(new SourceError('refused', 'fixture consent revoked'));
  await expect(status.complete(fixture, { model: 'fixture', messages: [], tools: [], stream: false, cwd: '/tmp' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'refused' });
});

it.each(['healthy', 'metadata', 'reply'] as const)('invalidates an ordinary negative observation after explicit %s evidence', async kind => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  expect(await status.available(fixture)).toBe(false);
  vi.mocked(fixture.available).mockResolvedValue(true);
  if (kind === 'healthy') status.healthy(fixture.id);
  if (kind === 'metadata') status.metadata(fixture.id, status.guard(fixture.id));
  if (kind === 'reply') await status.complete(fixture, { model: 'fixture', messages: [], tools: [], stream: false, cwd: '/tmp' }, new AbortController().signal);
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(2);
});

it('allows an explicit health check to bypass stale negative metadata', async () => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  expect(await status.available(fixture)).toBe(false);
  expect(await status.available(fixture, true)).toBe(true);
  expect(fixture.healthCheck).toHaveBeenCalledOnce();
  vi.mocked(fixture.available).mockResolvedValue(true);
  expect(await status.available(fixture)).toBe(true);
});

it('does not turn cancelled checks into a negative cooldown', async () => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  vi.mocked(fixture.available).mockRejectedValueOnce(new SourceError('cancelled', 'fixture caller cancelled')).mockResolvedValue(true);
  await expect(status.available(fixture)).rejects.toMatchObject({ code: 'cancelled' });
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(2);
});

it('does not extend short quota deadlines with an ordinary negative cooldown', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now), admission = new SourceAvailability(status);
  vi.mocked(fixture.available).mockRejectedValueOnce(new SourceError('quota', 'fixture daily quota', 2)).mockResolvedValue(true);
  expect(await status.available(fixture)).toBe(false);
  expect(status.quotaRetryAt(fixture.id)).toBe(2000);
  now = 2000;
  expect(admission.peek(fixture.id)).toBeUndefined();
  expect(await status.available(fixture)).toBe(true);
  await admission.close();
});

it('expires negative observations immediately if the wall clock moves backwards', async () => {
  let now = 10000;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now);
  expect(await status.available(fixture)).toBe(false);
  vi.mocked(fixture.available).mockResolvedValue(true); now = 9000;
  expect(await status.available(fixture)).toBe(true);
});

it('does not detach a real probe when negative evidence arrives between peek and admission', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now), admission = new SourceAvailability(status);
  expect(await status.available(fixture)).toBe(false);
  // Simulate a routing read that preceded the newer negative observation.
  vi.spyOn(status, 'routingAvailability').mockReturnValueOnce(undefined);
  expect(admission.start([fixture])).toBe(1); await turn();
  expect(fixture.available).toHaveBeenCalledOnce();
  expect(admission.hasPending()).toBe(false);
  now = 30000;
  expect(admission.start([fixture])).toBe(1); await turn();
  expect(fixture.available).toHaveBeenCalledTimes(2);
  await admission.close();
});

it('does not shorten a live completion quota deadline when metadata is unavailable', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now);
  status.failed(fixture.id, 'quota', 120);
  expect(await status.available(fixture)).toBe(false);
  now = 10000;
  expect(await status.available(fixture)).toBe(false);
  expect(fixture.available).toHaveBeenCalledOnce();
  expect(status.quotaRetryAt(fixture.id)).toBe(120000);
});

it.each(['logged_out', 'not_installed'] as const)('preserves immediate %s recovery after a repaired login or installation', async code => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  status.failed(fixture.id, code);
  expect(await status.available(fixture)).toBe(false);
  vi.mocked(fixture.available).mockResolvedValue(true);
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(2);
});

it.each(['logged_out', 'not_installed'] as const)('does not cache thrown %s barriers across ordinary setup checks', async code => {
  const fixture = source(), status = new SourceStatus([fixture.id]);
  vi.mocked(fixture.available).mockRejectedValueOnce(new SourceError(code, 'fixture setup required')).mockResolvedValue(true);
  await expect(status.available(fixture)).rejects.toMatchObject({ code });
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(2);
});

it('caps an older negative observation at a completion quota reset, then caches fresh negative evidence normally', async () => {
  let now = 0;
  const fixture = source(), status = new SourceStatus([fixture.id], () => now), admission = new SourceAvailability(status);
  status.failed(fixture.id, 'quota', 2);
  expect(await status.available(fixture)).toBe(false);
  now = 2000;
  expect(admission.peek(fixture.id)).toBeUndefined();
  expect(await status.available(fixture)).toBe(false);
  expect(fixture.available).toHaveBeenCalledTimes(2);
  now = 3000;
  expect(admission.peek(fixture.id)).toBe(false);
  expect(await status.available(fixture)).toBe(false);
  expect(fixture.available).toHaveBeenCalledTimes(2);
  now = 32000;
  expect(admission.peek(fixture.id)).toBeUndefined();
  vi.mocked(fixture.available).mockResolvedValue(true);
  expect(await status.available(fixture)).toBe(true);
  expect(fixture.available).toHaveBeenCalledTimes(3);
  await admission.close();
});
