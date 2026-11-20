// Owned child preload. The official CLI and its provider payloads stay intact.
// Only metadata crosses IPC; stdout remains untrusted model/CLI output.
const nonce = process.env.GRUNT_CLIXAD_NONCE;
const mode = process.argv[2];
const model = 'glm-5.3-flash', origin = 'https://clixad.onrender.com';
if (!process.send || !nonce || !/^[a-f0-9]{32}$/.test(nonce) || !['model', 'wallet', 'ask'].includes(mode ?? '') || process.argv.length !== 3) throw new Error('Clixad child invocation rejected');
const send = (event: string, fields: Record<string, unknown> = {}) => process.send?.({ type: 'grunt-clixad', version: 1, nonce, event, ...fields });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
function fail(): never {
  send('guard');
  process.exitCode = 73;
  setTimeout(() => process.exit(73), 10).unref();
  throw new Error('Clixad native guard rejected an unsupported action or response');
}
let prompt = '';
if (mode === 'ask') {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length; if (bytes > 2 * 1024 * 1024) fail(); chunks.push(data);
  }
  prompt = Buffer.concat(chunks).toString('utf8'); if (!prompt) fail();
  process.argv = [process.argv[0]!, process.argv[1]!, 'ask', prompt];
}
async function bounded(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) fail();
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) fail(); chunks.push(part.value); }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { void reader.cancel().catch(() => {}); }
}
async function observeStream(response: Response) {
  if (!response.body) fail();
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let bytes = 0, buffer = '', done = false;
  let usage: Record<string, unknown> | undefined, cost: Record<string, unknown> | undefined, returnedModel: string | undefined;
  function line(value: string) {
    if (!value.startsWith('data:')) return;
    const text = value.slice(5).trim(); if (!text) return;
    if (text === '[DONE]') { done = true; return; }
    if (done) fail();
    const frame = object(JSON.parse(text));
    if (frame.error) fail();
    if (frame.model !== undefined) { if (frame.model !== model) fail(); returnedModel = frame.model as string; }
    if (Array.isArray(frame.choices) && frame.choices.some(choice => {
      const delta = object(object(choice).delta); return ['tool_calls', 'function_call'].some(key => key in delta);
    })) fail();
    if (frame.usage !== undefined) {
      const raw = object(frame.usage), projected = { inputTokens: numeric(raw.prompt_tokens), outputTokens: numeric(raw.completion_tokens) };
      if (projected.inputTokens === undefined || projected.outputTokens === undefined || (usage && JSON.stringify(usage) !== JSON.stringify(projected))) fail();
      usage = projected;
    }
    if (frame.clixad !== undefined) {
      const raw = object(frame.clixad), projected = { free: raw.free, creditsCharged: numeric(raw.credits_charged), balance: numeric(raw.balance), creditsLeft: numeric(raw.free_credits_left) };
      if (projected.free !== true || projected.creditsCharged !== 0 || projected.balance !== 0 || projected.creditsLeft === undefined
        || (cost && JSON.stringify(cost) !== JSON.stringify(projected))) fail();
      cost = projected;
    }
  }
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) fail();
      buffer += decoder.decode(part.value, { stream: true }); if (Buffer.byteLength(buffer) > 131072) fail();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) line(buffer.trim());
    if (!done || !usage || !cost) fail();
    send('completion', { ...usage, ...cost, ...(returnedModel ? { returnedModel } : {}) });
  } finally { void reader.cancel().catch(() => {}); }
}
const original = globalThis.fetch;
const counts = new Map<string, number>();
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) fail();
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const operation = mode === 'wallet' && method === 'GET' && url.pathname === '/v1/wallet' ? 'wallet'
    : mode === 'ask' && method === 'POST' && url.pathname === '/v1/chat/completions' ? 'chat' : undefined;
  if (!operation || counts.has(operation)) fail(); counts.set(operation, 1);
  if (operation === 'chat') {
    // Validate the CLI's actual dispatch immediately before its single POST.
    // Never inspect, change, save or send authorization headers through IPC.
    if (typeof init?.body !== 'string') fail();
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(init.body)); } catch { fail(); }
    const messages = body.messages;
    if (body.model !== model || body.stream !== true || body.tools !== undefined || !Array.isArray(messages) || messages.length !== 1
      || object(messages[0]).role !== 'user' || object(messages[0]).content !== prompt
      || Object.keys(body).some(key => !['model', 'messages', 'stream', 'reasoning_effort'].includes(key))) fail();
    send('dispatch', { model });
  }
  // Redirect policy is a local transport guard. Native URL, body and headers
  // are otherwise passed unchanged; no compressed retry or alternate route.
  const response = await Reflect.apply(original, this, [input, { ...init, redirect: 'error' }]);
  if (response.url && new URL(response.url).origin !== origin) fail();
  send('http', { operation, status: response.status });
  if (response.ok && operation === 'wallet') {
    const body = await bounded(response.clone(), 262144), free = object(body.free_tier);
    send('wallet', { balance: numeric(body.balance), dailyCredits: numeric(free.daily_credits), creditsLeft: numeric(free.credits_left),
      modelEligible: Array.isArray(free.models) && free.models.includes(model), turnsLeft: numeric(object(free.turns_left)[model]) });
  }
  if (response.ok && operation === 'chat') void observeStream(response.clone()).catch(() => { try { fail(); } catch { /* The owned child terminates. */ } });
  return response;
};
