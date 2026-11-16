// One attempt per call. Grunt owns model selection, retry and cancellation.
export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  constructor(options: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  }
  chatCompletions(options: { headers: Headers; body: Record<string, unknown>; signal: AbortSignal }) {
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: { authorization: options.headers.get("authorization") ?? "", "content-type": "application/json", "x-title": "Grunt", "user-agent": "grunt" },
      body: JSON.stringify(options.body), signal: options.signal,
    });
  }
}
