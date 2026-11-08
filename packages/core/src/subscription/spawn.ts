/**
 * Runs a CLI as a child process and streams its stdout line by line.
 *
 * Kept behind the `Spawner` type so the backends can be unit tested against
 * fake binaries (real child processes, scripted output) and so nothing in the
 * backends ever touches the CLI's own files: all Milo sees is what the CLI
 * prints.
 */

import { spawn } from "node:child_process";

export type SpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** Kills the child (SIGTERM, then SIGKILL) after this long. */
  timeoutMs?: number;
  /** Called for every complete stdout line, in order. */
  onLine?: (line: string) => void;
};

export type SpawnResult = {
  /** Exit code, or `null` when the child was killed by a signal. */
  code: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the binary could not be started at all (ENOENT, EACCES...). */
  spawnError?: string;
};

export type Spawner = (command: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

/** How much stderr to keep for diagnostics. */
const STDERR_LIMIT = 16_384;
const KILL_GRACE_MS = 2_000;

export const spawnProcess: Spawner = (command, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let stderr = "";
    let buffered = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    };

    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, opts.timeoutMs)
        : undefined;
    timer?.unref();

    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // A throwing consumer must not take the process down from inside a
    // stream event handler.
    const emit = (line: string): void => {
      try {
        opts.onLine?.(line);
      } catch {
        // ignored: the consumer's own state is its problem
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line !== "") emit(line);
        newline = buffered.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    });

    child.on("error", (err) => {
      finish({ code: null, stderr, timedOut, aborted, spawnError: err.message });
    });

    child.on("close", (code) => {
      const tail = buffered.replace(/\r$/, "");
      if (tail !== "") emit(tail);
      buffered = "";
      finish({ code, stderr, timedOut, aborted });
    });

    // A child that exits before reading stdin raises EPIPE here; the exit is
    // what matters, so the write error is ignored.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });

/**
 * The environment a subscription CLI runs with: the user's own, minus the
 * pay-per-token API keys. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set,
 * the CLIs bill the API key instead of the logged-in subscription, which is
 * the opposite of what Milo is for. Milo removes the variables; it never reads
 * their values.
 */
export function subscriptionEnv(base: NodeJS.ProcessEnv, keepApiKeys = false): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!keepApiKeys) {
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    delete env["OPENAI_API_KEY"];
    delete env["CODEX_API_KEY"];
  }
  return env;
}
