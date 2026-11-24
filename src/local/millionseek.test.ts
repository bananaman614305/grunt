import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { MillionSeek, MILLIONSEEK_MODEL } from './millionseek.js';
import { claudeCodeRequest } from './fixtures/claude-code-tools.js';

const now = Date.parse('2026-11-20T15:00:00Z'), reset = '2026-11-21T00:00:00.000Z';
const grant = { base_url: 'https://100milionseek.top', token: 'synthetic-key' };
let directory: string;
const headers = (remaining = 100000000) => ({ 'x-quota-limit': '100000000', 'x-quota-used': String(100000000 - remaining), 'x-quota-remaining': String(remaining), 'x-quota-reset': reset });
const status = () => ({ updated_at: new Date(now).toISOString(), base_daily_tokens: 100000000, model: { id: MILLIONSEEK_MODEL, context_length: 198000, max_output_tokens: 65536, tools: true }, allowance: { reset: '00:00 UTC', session_limit: 5, daily_tokens: 100000000 } });
const offer = () => ({ id: MILLIONSEEK_MODEL, owned_by: '100milionseek', context_length: 198000, max_output_tokens: 65536, quota_multiplier: 1 });
const answer = () => ({ model: MILLIONSEEK_MODEL, choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
const req = () => ({ model: 'millionseek', messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], stream: false, cwd: directory, maxTokens: 128 });
function transport(options: { state?: unknown; model?: unknown; completion?: unknown; quota?: number; response?: () => Response } = {}) {
  return vi.fn<typeof fetch>(async input => String(input).endsWith('/api/status') ? Response.json(options.state ?? status())
    : String(input).endsWith('/v1/models') ? Response.json({ data: [options.model ?? offer()] }, { headers: headers(options.quota) })
      : options.response?.() ?? Response.json(options.completion ?? answer(), { headers: headers() }));
}
const source = (fetcher: typeof fetch, access = grant) => new MillionSeek({ directory, fetcher, now: () => now, loadGrant: async () => access });
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'millionseek-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('does not send metadata or prompts before current source-specific consent', async () => {
  const fetcher = transport(); await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(fetcher).not.toHaveBeenCalled();
});
it('pins the exact free endpoint and base recurring allowance independently of bonuses', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport({ state: { ...status(), allowance: { ...status().allowance, daily_tokens: 400000000 } } });
  const s = source(fetcher); await expect(s.complete(req(), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'Hello', inputTokens: 20, outputTokens: 2 });
  const [url, init] = fetcher.mock.calls.at(-1)!; expect(url).toBe('https://100milionseek.top/v1/chat/completions'); expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({ model: MILLIONSEEK_MODEL, messages: req().messages, stream: false, max_tokens: 128 });
  expect(s.quotaWindow()).toEqual({ startedAt: Date.parse('2026-11-20T00:00:00Z'), resetAt: Date.parse(reset) });
});
it.each([
  { ...status(), updated_at: '2026-11-19T15:00:00Z' }, { ...status(), base_daily_tokens: 0 },
  { ...status(), model: { ...status().model, tools: false } }, { ...status(), allowance: { ...status().allowance, reset: 'rolling' } },
])('rejects stale or changed permanent free entitlement before inference', async state => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport({ state });
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{ ...offer(), id: 'paid-model' }, { ...offer(), context_length: 32000 }, { ...offer(), quota_multiplier: 5 }])('rejects catalog route changes before inference', async model => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport({ model });
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not send credentials to an injected endpoint', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport();
  await expect(source(fetcher, { ...grant, base_url: 'https://example.com' }).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(fetcher).not.toHaveBeenCalled();
});
it('stops at the daily allowance without sending inference and reports midnight reset', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport({ quota: 0 });
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota', retryAfter: 9 * 3600 }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([['daily_quota_exceeded', 9 * 3600], ['session_limit_reached', 2]])('keeps %s separate from other quota errors', async (code, retryAfter) => {
  await recordDataSharingConsent(directory, ['millionseek']); const fetcher = transport({ response: () => Response.json({ error: { code } }, { status: 429, headers: { 'Retry-After': '2' } }) });
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota', retryAfter });
});
it.each([{ ...answer(), model: 'unverified' }, { ...answer(), usage: { prompt_tokens: 20, completion_tokens: 129 } }, { ...answer(), usage: { prompt_tokens: 20, completion_tokens: 2, cost: 1 } }])('rejects model, output-budget and charge attestation failures', async completion => {
  await recordDataSharingConsent(directory, ['millionseek']); await expect(source(transport({ completion })).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
});
it('accepts only requested, schema-valid inert native function calls', async () => {
  await recordDataSharingConsent(directory, ['millionseek']);
  const call = { id: 'call-test', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"ok"}' } };
  const completion = { ...answer(), choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] };
  const request = { ...req(), tools: [{ type: 'function', function: { name: 'record_probe', parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } } }] };
  await expect(source(transport({ completion })).complete(request, AbortSignal.timeout(1000))).resolves.toMatchObject({ text: '', calls: [call] });
  call.function.arguments = '{"marker":42}'; await expect(source(transport({ completion })).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
});
it('accepts every tool of a recorded Claude Code request', async () => {
  await recordDataSharingConsent(directory, ['millionseek']);
  const completion = { ...answer(), choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hi"}' } }] }, finish_reason: 'tool_calls' }] };
  for (const index of [0, 1, 2] as const) {
    const fetcher = transport({ completion });
    await expect(source(fetcher).complete({ ...claudeCodeRequest(index, 'millionseek'), cwd: directory }, AbortSignal.timeout(1000))).resolves.toMatchObject({ calls: [{ function: { name: 'Bash' } }] });
    const sent = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body));
    expect(sent.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(claudeCodeRequest(index).tools.map(t => (t as { function: { name: string } }).function.name));
  }
  // The completion is still validated against the Claude Code schema.
  completion.choices[0]!.message.tool_calls[0]!.function.arguments = '{"command":"echo hi","unknown":1}';
  await expect(source(transport({ completion })).complete({ ...claudeCodeRequest(0, 'millionseek'), cwd: directory }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
});
