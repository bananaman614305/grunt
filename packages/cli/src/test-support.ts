/**
 * Test-only helpers for building a `CliDeps` with every side effect stubbed
 * out. Not part of the published package (excluded from the build in
 * tsconfig.json, same as `*.test.ts`).
 */
import type { CliDeps } from "./deps.js";

export class MemoryWriter {
  private chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

/**
 * A `CliDeps` where every side-effecting field throws unless overridden --
 * a test that unexpectedly reaches the gateway, the log, or a real server
 * fails loudly instead of doing something real.
 */
export function createTestDeps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  stdout: MemoryWriter;
  stderr: MemoryWriter;
} {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const deps: CliDeps = {
    createGateway: () => {
      throw new Error("createGateway was not expected to be called in this test");
    },
    openLog: () => {
      throw new Error("openLog was not expected to be called in this test");
    },
    env: {},
    stdout,
    stderr,
    serve: () => {
      throw new Error("serve was not expected to be called in this test");
    },
    fetch: () => {
      throw new Error("fetch was not expected to be called in this test");
    },
    ...overrides,
  };

  return { deps, stdout, stderr };
}
