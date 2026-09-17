/**
 * Node HTTP server around a Gateway.
 *
 * Deliberately not exported from `index.ts`: that contract is pinned so the
 * CLI could be built against it in parallel, and importing this module pulls
 * in `@hono/node-server`, which a caller embedding the app in another runtime
 * has no use for. The CLI imports `@milo/gateway/server`.
 */

import { serve } from "@hono/node-server";
import type { Gateway } from "./index.js";

export type StartServerOptions = {
  /** 0 asks the OS for a free port; the resolved value comes back. */
  port: number;
  hostname?: string;
};

export type RunningServer = {
  port: number;
  close(): Promise<void>;
};

export async function startServer(gateway: Gateway, opts: StartServerOptions): Promise<RunningServer> {
  return new Promise<RunningServer>((resolve, reject) => {
    const options: { fetch: typeof gateway.app.fetch; port: number; hostname?: string } = {
      fetch: gateway.app.fetch,
      port: opts.port,
    };
    if (opts.hostname !== undefined) options.hostname = opts.hostname;

    const server = serve(options, (info) => {
      server.off("error", reject);
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            // Keep-alive sockets (the `openai` SDK holds one open) would keep
            // `close` pending until they time out, so drop them first. HTTP/2
            // servers have no such method, hence the guard.
            const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(server);
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });

    server.on("error", reject);
  });
}
