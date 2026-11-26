import { lengthLimited, truncatedCompletion, withObservedEnding, SourceError } from './source.js';
import type { Completion, ModelRequest, ToolCall } from './source.js';

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export async function selectedStatus(id: string, response: Response) {
  if (response.ok) return;
  const raw = response.headers.get('Retry-After');
  const retry = raw === null ? NaN : /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  await response.body?.cancel();
  throw new SourceError(response.status === 429 ? 'quota' : response.status === 401 ? 'logged_out' : [402, 403].includes(response.status) ? 'refused' : 'upstream',
    `${id} returned HTTP ${response.status}`, Number.isFinite(retry) && retry > 0 ? retry : undefined, undefined,
    { httpStatus: response.status, transport: 'http' });
}

export function selectedReply(id: string, payload: unknown, request: ModelRequest, exactModel: (model: unknown) => boolean): Completion {
  const body = object(payload);
  const choice = object(Array.isArray(body.choices) && body.choices.length === 1 ? body.choices[0] : undefined), message = object(choice.message);
  const usage = object(body.usage);
  if (!exactModel(body.model) || message.refusal || (message.tool_calls != null && !Array.isArray(message.tool_calls))) {
    throw new SourceError('upstream', `${id} returned an unexpected model or completion`);
  }
  if (lengthLimited(choice.finish_reason)) return truncatedCompletion(message?.content, usage, choice.finish_reason);
  const functions = new Set(request.tools.map(tool => object(tool.function).name));
  const ids = new Set(request.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
  const calls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) for (const raw of message.tool_calls) {
    const call = object(raw), fn = object(call.function);
    const args: unknown = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : null;
    if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id)
      || typeof fn.name !== 'string' || !functions.has(fn.name) || typeof fn.arguments !== 'string'
      || args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new SourceError('upstream', `${id} returned an invalid native tool call`);
    }
    ids.add(call.id);
    calls.push({ id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
  }
  const text = typeof message.content === 'string' ? message.content : '';
  if (!text && !calls.length) throw new SourceError('upstream', `${id} returned an empty completion`);
  const inputTokens = tokens(usage.prompt_tokens), outputTokens = tokens(usage.completion_tokens);
  return withObservedEnding({ text, ...(calls.length ? { calls } : {}), ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) },
        choice.finish_reason, usage, calls.length > 0);
}
