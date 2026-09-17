/**
 * Client over OpenRouter's Provisioning API keys endpoints, confirmed
 * 2026-09-17 against https://openrouter.ai/docs/features/provisioning-api-keys,
 * https://openrouter.ai/docs/api-reference/api-keys/create-api-key, and
 * https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits:
 *
 *   GET    /api/v1/keys            list keys, `data: []`, paginate with `?offset=`
 *   POST   /api/v1/keys            create a key. Body: `name` (string, required),
 *                                  `limit` (number, USD, optional). Response:
 *                                  `{ key: string, data: { hash, name, label,
 *                                  disabled, limit, limit_remaining, usage, ... } }`.
 *                                  `key` is the plaintext secret and is returned
 *                                  ONLY here — OpenRouter cannot show it again.
 *   GET    /api/v1/keys/{hash}     read one key's current state, including
 *                                  cumulative `usage` (all-time USD spend on
 *                                  that key) and `limit`/`limit_remaining`.
 *   PATCH  /api/v1/keys/{hash}     update `name`, `disabled`, `limit`,
 *                                  `limit_reset`, `include_byok_in_limit`.
 *   DELETE /api/v1/keys/{hash}     remove a key.
 *   GET    /api/v1/credits         Milo's own account-wide balance (needs a
 *                                  management/provisioning key, not a regular
 *                                  inference key). Response:
 *                                  `{ data: { total_credits, total_usage } }`,
 *                                  both lifetime USD totals; balance is their
 *                                  difference.
 *
 * Auth: `Authorization: Bearer <OPENROUTER_PROVISIONING_KEY>` on every call.
 * The provisioning key is never logged, never put in an error message, and
 * never included in a thrown error's `body`.
 *
 * 429 / 5xx: OpenRouter says retry with exponential backoff and to honor
 * `Retry-After` when present (seconds, or an HTTP-date). This client retries
 * idempotent-in-practice requests (get/list/update/delete) and, per the
 * task's instruction to retry on 429/5xx generally, also retries `createKey`
 * — see the open question in the package README about the resulting
 * at-most-once-vs-at-least-once tradeoff on create.
 */

type FetchLike = typeof fetch;

export class ProvisioningError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, status: number, opts?: { requestId?: string; body?: unknown }) {
    super(message);
    this.name = "ProvisioningError";
    this.status = status;
    if (opts?.requestId !== undefined) this.requestId = opts.requestId;
    if (opts?.body !== undefined) this.body = opts.body;
  }
}

export type OpenRouterProvisioningClientOptions = {
  /** Defaults to `process.env.OPENROUTER_PROVISIONING_KEY`. Never logged. */
  provisioningKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Max retry attempts on 429/5xx before giving up. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff when no `Retry-After` is given. Default 300ms. */
  retryBaseMs?: number;
};

export type CreateKeyOptions = {
  name: string;
  /** USD spend limit for the key. Omit for no limit. */
  limitUsd?: number;
};

export type CreateKeyResult = {
  /** Plaintext key. Returned once; OpenRouter never shows it again. */
  key: string;
  hash: string;
  /**
   * OpenRouter's own identifier for a provisioned key is its `hash` — the
   * API has no separate numeric/string id field, so `id` mirrors `hash`.
   */
  id: string;
};

export type KeyInfo = {
  hash: string;
  name: string;
  label?: string;
  disabled: boolean;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  /** Cumulative all-time USD spend on this key, as reported by OpenRouter. */
  usageUsd: number;
  createdAt?: string;
  updatedAt?: string;
};

export type UpdateKeyOptions = {
  limitUsd?: number;
  disabled?: boolean;
};

export type Credits = {
  totalCreditsUsd: number;
  totalUsageUsd: number;
  balanceUsd: number;
};

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvisioningClient {
  private readonly provisioningKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(opts: OpenRouterProvisioningClientOptions = {}) {
    const key = opts.provisioningKey ?? process.env.OPENROUTER_PROVISIONING_KEY;
    if (!key) {
      throw new ProvisioningError("OPENROUTER_PROVISIONING_KEY is not set", 0);
    }
    this.provisioningKey = key;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 300;
  }

  async createKey(opts: CreateKeyOptions): Promise<CreateKeyResult> {
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.limitUsd !== undefined) body.limit = opts.limitUsd;

    const json = await this.request<{ key: string; data: RawKeyData }>("POST", "/keys", { body });
    return { key: json.key, hash: json.data.hash, id: json.data.hash };
  }

  async getKey(hash: string): Promise<KeyInfo> {
    const json = await this.request<{ data: RawKeyData }>("GET", `/keys/${encodeURIComponent(hash)}`);
    return toKeyInfo(json.data);
  }

  async updateKey(hash: string, opts: UpdateKeyOptions): Promise<KeyInfo> {
    const body: Record<string, unknown> = {};
    if (opts.limitUsd !== undefined) body.limit = opts.limitUsd;
    if (opts.disabled !== undefined) body.disabled = opts.disabled;

    const json = await this.request<{ data: RawKeyData }>("PATCH", `/keys/${encodeURIComponent(hash)}`, { body });
    return toKeyInfo(json.data);
  }

  async deleteKey(hash: string): Promise<void> {
    await this.request<unknown>("DELETE", `/keys/${encodeURIComponent(hash)}`);
  }

  async listKeys(): Promise<KeyInfo[]> {
    const json = await this.request<{ data: RawKeyData[] }>("GET", "/keys");
    return (json.data ?? []).map(toKeyInfo);
  }

  /** Milo's own account-wide balance on the provisioning key's account. */
  async getCredits(): Promise<Credits> {
    const json = await this.request<{ data: { total_credits: number; total_usage: number } }>("GET", "/credits");
    const totalCreditsUsd = json.data.total_credits;
    const totalUsageUsd = json.data.total_usage;
    return { totalCreditsUsd, totalUsageUsd, balanceUsd: totalCreditsUsd - totalUsageUsd };
  }

  private async request<T>(method: string, path: string, opts?: { body?: Record<string, unknown> }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers();
    headers.set("authorization", `Bearer ${this.provisioningKey}`);
    headers.set("accept", "application/json");
    const init: RequestInit = { method, headers };
    if (opts?.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(opts.body);
    }

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        throw new ProvisioningError(`OpenRouter provisioning request failed: ${toErrorMessage(err)}`, 0);
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await sleep(retryDelayMs(response, attempt, this.retryBaseMs));
        attempt += 1;
        continue;
      }

      const requestId = response.headers.get("x-request-id") ?? undefined;
      const body = await safeJson(response);
      const opts2: { requestId?: string; body?: unknown } = {};
      if (requestId !== undefined) opts2.requestId = requestId;
      if (body !== undefined) opts2.body = body;
      throw new ProvisioningError(`OpenRouter provisioning request to ${path} failed with status ${response.status}`, response.status, opts2);
    }
  }
}

type RawKeyData = {
  hash: string;
  name: string;
  label?: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  usage: number;
  created_at?: string;
  updated_at?: string;
};

function toKeyInfo(data: RawKeyData): KeyInfo {
  const info: KeyInfo = {
    hash: data.hash,
    name: data.name,
    disabled: data.disabled,
    limitUsd: data.limit,
    limitRemainingUsd: data.limit_remaining,
    usageUsd: data.usage,
  };
  if (data.label !== undefined) info.label = data.label;
  if (data.created_at !== undefined) info.createdAt = data.created_at;
  if (data.updated_at !== undefined) info.updatedAt = data.updated_at;
  return info;
}

function retryDelayMs(response: Response, attempt: number, baseMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return baseMs * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
