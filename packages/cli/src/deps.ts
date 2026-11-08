/**
 * Everything a command touches that is not pure: the gateway constructor,
 * the decision log opener, the environment, standard streams, and the HTTP
 * server starter. Every command takes these as a parameter instead of
 * importing the real thing, so tests exercise the CLI's own logic without a
 * network, a real gateway, or a real listening socket.
 */
import type { DecisionLog } from "@milo/core";
import type { Gateway, GatewayOptions } from "@milo/gateway";

export type Writer = { write(chunk: string): void };

/** The subset of `fetch` `milo usage --url` and `milo replay` use. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The subset of `@hono/node-server`'s `Options` the CLI relies on. */
export type ServeOptions = {
  fetch: (request: Request) => Response | Promise<Response>;
  port?: number;
  hostname?: string;
};

export type ServeResult = {
  close(callback?: (err?: Error) => void): unknown;
};

export type ServeFn = (
  options: ServeOptions,
  listeningListener?: (info: { address: string; port: number }) => void,
) => ServeResult;

export type CliDeps = {
  createGateway: (options: GatewayOptions) => Promise<Gateway>;
  openLog: (url: string) => Promise<DecisionLog>;
  env: NodeJS.ProcessEnv;
  stdout: Writer;
  stderr: Writer;
  serve: ServeFn;
  /** HTTP client for `milo usage --url` and `milo replay` (real `fetch` in production). */
  fetch: FetchLike;
};
