import { expect, it } from 'vitest';
import { bundledRegistry, localOptInAdapterIds } from '../registry.js';
import { calendarQuotaDelay, providerQuotaPolicy } from './quota-policy.js';
import { nousQuotaDelay, quotaRetryAfter } from './quota-timing.js';

it('covers each default and optional free route with first-party quota documentation', () => {
  const ids = [...bundledRegistry.adapters.map(adapter => adapter.id), ...localOptInAdapterIds];
  for (const id of ids) expect(providerQuotaPolicy(id), id).toMatchObject({
    refill: expect.any(String), detail: expect.any(String), documentation: expect.stringMatching(/^https:\/\//)
  });
  expect(providerQuotaPolicy('unknown-adapter')).toBeUndefined();
  expect(providerQuotaPolicy('constructor')).toBeUndefined();
});

it('computes exact UTC refills only for schedules with a published UTC cutoff', () => {
  const now = Date.parse('2026-11-30T23:59:59.950Z');
  expect(calendarQuotaDelay('clixad', now)).toBe(1);
  expect(calendarQuotaDelay('perch', now)).toBe(1);
  expect(calendarQuotaDelay('perch', now + 50)).toBe(31 * 86400);
  for (const id of ['runcrate', 'zro', 'livekit', 'tokenharbor', 'numes']) expect(calendarQuotaDelay(id, now)).toBeUndefined();
});

it('uses bounded structured Nous dates and ignores arbitrary messages and malformed Retry-After values', () => {
  const now = Date.parse('2026-11-19T09:00:00Z');
  expect(nousQuotaDelay(new Headers(), { error: { resets_at: '2026-11-19T04:05:00-05:00' } }, now)).toBe(300);
  expect(nousQuotaDelay(new Headers(), { error: { reset_at: now / 1000 + 45 } }, now)).toBe(45);
  expect(nousQuotaDelay(new Headers(), { error: { message: 'try next month', retry_after: 1e9 } }, now)).toBeUndefined();
  expect(quotaRetryAfter('Thu, 19 Nov 2026 09:03:00 GMT', now)).toBe(180);
  expect(quotaRetryAfter('9999999999', now)).toBeUndefined();
});
