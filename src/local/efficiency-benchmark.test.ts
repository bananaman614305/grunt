import { expect, it, vi } from 'vitest';
import { measureFallbackTasks, runEfficiencyBenchmark } from './efficiency-benchmark.js';
import { SourceError, Sources } from './source.js';

it('verifies synthetic tasks and records both failed and successful attempts', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await measureFallbackTasks({ Sources, SourceError }, 2, { firstOutputMs: 10, failMs: 80, outputMs: 1, answerMs: 1 });
    expect(result.completedTasks).toBe(2);
    expect(result.attempts).toBe(4);
    expect(result.medianMs).toBeGreaterThan(0);
    expect(result.p90Ms).toBeGreaterThanOrEqual(result.medianMs);
  } finally { log.mockRestore(); }
});

it('rejects invalid benchmark work bounds before running tasks', async () => {
  await expect(measureFallbackTasks({ Sources, SourceError }, 0)).rejects.toThrow('1–100');
  await expect(runEfficiencyBenchmark(['--iterations', '1000'])).rejects.toThrow('1–100');
  await expect(runEfficiencyBenchmark(['--baseline'])).rejects.toThrow('Usage');
  await expect(runEfficiencyBenchmark(['--unknown', 'value'])).rejects.toThrow('Unknown');
});

it('fails the benchmark rather than counting an incorrect fast answer', async () => {
  class IncorrectRuntime {
    async complete() { return { text: '{"square":0}' }; }
    async close() {}
  }
  await expect(measureFallbackTasks({ Sources: IncorrectRuntime, SourceError }, 1)).rejects.toThrow('verification failed');
});
