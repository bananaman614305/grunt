const maxDelaySeconds = 31 * 86400;

export function quotaSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= maxDelaySeconds ? Math.max(1, Math.ceil(seconds)) : undefined;
}

export function quotaRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return;
  // Do not fall through to Date.parse for malformed or oversized numeric delays.
  return /^\d+(?:\.\d+)?$/.test(value) ? quotaSeconds(value) : quotaSeconds(Math.max(0, (Date.parse(value) - now) / 1000));
}

export function quotaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Only documented quota fields may inform timing. Do not trust error prose or
// retain the provider response. Large error pages must not delay failover.
export async function readQuotaError(response: Response) {
  const body = response.body;
  if (!body) return {};
  const maxBytes = 8192;
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) return quotaObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      size += chunk.value.length;
      if (size <= maxBytes) chunks.push(chunk.value);
    }
  } catch { /* A non-JSON error can still carry Retry-After. */ }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return {};
}

const resetAtDelay = (value: unknown, now: number) => {
  const epoch = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(epoch)) return quotaSeconds(epoch - now / 1000);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  return quotaSeconds((Date.parse(value) - now) / 1000);
};

export function nousQuotaDelay(headers: Headers, body: Record<string, unknown>, now = Date.now()): number | undefined {
  let delay = Math.max(quotaRetryAfter(headers.get('Retry-After'), now) ?? 0,
    quotaSeconds(headers.get('x-ratelimit-reset-requests-1h')) ?? 0, quotaSeconds(headers.get('x-ratelimit-reset-requests')) ?? 0);
  for (const scope of [body, quotaObject(body.error)]) delay = Math.max(delay, quotaSeconds(scope.resets_in_seconds) ?? 0,
    quotaSeconds(scope.retry_after) ?? 0, resetAtDelay(scope.resets_at, now) ?? 0, resetAtDelay(scope.reset_at, now) ?? 0);
  return delay || undefined;
}
