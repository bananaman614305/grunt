import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
import { webhookPost } from './dots-events.js';
afterEach(() => vi.resetAllMocks());
it('rejects DNS answers containing private addresses on every callback connection', async () => {
  mocks.lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
  await expect(webhookPost('https://receiver.example/events', '{}', {})).rejects.toThrow('private_callback');
  mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await expect(webhookPost('https://receiver.example/events', '{}', {})).rejects.toThrow('private_callback');
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
});
