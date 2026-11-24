// Test helper: the recorded Claude Code 2.1.331 Messages requests in claude-code-tools.json,
// decoded exactly as the local API decodes them before any source sees them.
import { readFileSync } from 'node:fs';
import { decode } from '../api.js';
import type { ModelRequest } from '../source.js';

interface Recorded { requests: Record<string, unknown>[] }
const recorded = JSON.parse(readFileSync(new URL('./claude-code-tools.json', import.meta.url), 'utf8')) as Recorded;

// 0: first turn, 1: after parallel Bash + Read results, 2: after a ToolSearch tool_reference result.
export function claudeCodeRequest(index: 0 | 1 | 2, model = 'grunt'): ModelRequest {
  return { ...decode({ ...recorded.requests[index]!, model, stream: false }, 'messages'), cwd: '/synthetic' };
}
