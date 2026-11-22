import { expect, it, vi } from 'vitest';
import { firstWorkingGrant } from './provider-grant.js';
import { SourceError } from './source.js';

const valid = { base_url: 'https://egress.example.test', token: 'synthetic-token' };

it.each(['grant', 'validation', 'availability'] as const)('tries a later key after a candidate %s failure', async failure => {
  const grant = vi.fn(async (reference: string) => {
    if (reference === 'first') {
      if (failure === 'grant') throw new Error('unavailable credential');
      if (failure === 'validation') return { base_url: 'http://invalid.test', token: 'invalid' };
      return { ...valid, token: 'exhausted' };
    }
    return valid;
  });
  const works = vi.fn(async (candidate: typeof valid) => {
    if (candidate.token === 'exhausted') throw new SourceError('quota', 'Quota exhausted');
    return true;
  });
  expect(await firstWorkingGrant(['first', 'second'], grant, works)).toEqual(valid);
  expect(grant.mock.calls).toEqual([['first'], ['second']]);
});

it('stops selecting keys when an availability check is cancelled', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const grant = vi.fn(async () => valid);
  await expect(firstWorkingGrant(['first', 'second'], grant, async () => {
    controller.abort(reason);
    throw reason;
  }, controller.signal)).rejects.toBe(reason);
  expect(grant).toHaveBeenCalledTimes(1);
});
