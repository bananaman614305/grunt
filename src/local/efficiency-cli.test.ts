import { expect, test, vi } from 'vitest';
import { efficiencyCommand } from './efficiency-cli.js';

test('reads aggregates from loopback only and preserves explicit time windows', async () => {
  const report = { version: 1, buckets: [], coverage: { available: true } };
  const fetcher = vi.fn(async () => Response.json(report)), output = vi.fn();
  await efficiencyCommand(['metrics', '--port', '8793', '--since', '100', '--until', '200'], { fetcher, output });
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:8793/v1/diagnostics/metrics?since=100&until=200');
  expect(output).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
});

test.each([['metrics', '--url', 'https://example.com'], ['metrics', '--port', '80'], ['metrics', '--port', '8792', '--port', '8793'], ['metrics', '--since', '200', '--until', '100'], ['metrics', '--since', 'NaN']])('rejects invalid arguments before any request: %j', async (...args) => {
  const fetcher = vi.fn(); await expect(efficiencyCommand(args, { fetcher })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});

test('unavailable measurements fail without printing an error response body', async () => {
  const output = vi.fn();
  await expect(efficiencyCommand(['metrics'], { fetcher: async () => new Response('private diagnostic detail', { status: 503 }), output, env: { GRUNT_PORT: '8788' } })).rejects.toThrow('unavailable');
  expect(output).not.toHaveBeenCalled();
});

test('uses the trusted launch port and allows an explicit override', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => { urls.push(String(input)); return Response.json({ version: 1, buckets: [], coverage: { available: true } }); };
  const dependencies = { fetcher, output: () => {}, env: { GRUNT_PORT: '8789' } };
  await efficiencyCommand(['metrics'], dependencies);
  await efficiencyCommand(['metrics', '--port', '8793'], dependencies);
  expect(urls).toEqual(['http://127.0.0.1:8789/v1/diagnostics/metrics', 'http://127.0.0.1:8793/v1/diagnostics/metrics']);
});
