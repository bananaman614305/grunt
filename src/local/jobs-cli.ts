import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalJobRunner, JobScheduler, jobsStateDirectory, readJobResult, readJobSession, requestJobCancel } from './jobs.js';

const usage = 'Usage: usegrunt jobs <run [--category test|build|render|download|other] [--timeout seconds] [--check id] [--artifact path] -- command | status | result id | cancel id>';
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
export interface JobsCommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; notify?: (value: string) => void; helperEntry?: string }
/** Explicit local CLI execution only. No HTTP/MCP daemon endpoint exposes host command execution. */
export async function jobsCommand(args: string[], options: JobsCommandOptions = {}) {
  const [operation, ...rest] = args, notify = options.notify ?? console.log, directory = jobsStateDirectory(options.env ?? process.env);
  if (operation === 'status' && rest.length === 0) {
    let entries: Dirent[];
    try { entries = await readdir(join(directory, 'sessions'), { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; entries = []; }
    const sessions = [];
    for (const entry of entries.slice(0, 100)) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const snapshot = await readJobSession(directory, entry.name); if (snapshot) sessions.push(snapshot);
    }
    notify(JSON.stringify({ sessions })); return;
  }
  if ((operation === 'result' || operation === 'cancel') && rest.length === 1) {
    notify(JSON.stringify(operation === 'result' ? await readJobResult(directory, rest[0]!) : await requestJobCancel(directory, rest[0]!))); return;
  }
  if (operation !== 'run') throw new Error(usage);
  let category = 'other', timeoutSeconds = 900, index = 0, checkId: string | undefined; const artifactPaths: string[] = [];
  while (index < rest.length && rest[index] !== '--') {
    const flag = rest[index++], value = rest[index++];
    if (flag === '--category' && value) category = value;
    else if (flag === '--check' && value) checkId = value;
    else if (flag === '--artifact' && value) artifactPaths.push(value);
    else if (flag === '--timeout' && value && /^\d+$/.test(value)) timeoutSeconds = Number(value);
    else throw new Error(usage);
  }
  if (rest[index] !== '--' || !rest[index + 1]) throw new Error(usage);
  if (artifactPaths.length && !checkId) throw new Error('Artifact verification needs --check id.');
  const command = rest.slice(index + 1).map(quote).join(' ');
  const scheduler = await JobScheduler.open({ sessionId: `cli-${randomUUID()}`, stateDirectory: directory, runner: createLocalJobRunner(options.helperEntry ? { helperEntry: options.helperEntry } : {}) });
  const interrupt = () => { for (const row of [...scheduler.snapshot().active, ...scheduler.snapshot().queued]) scheduler.cancel(row.id); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const started = await scheduler.start({ command, category, timeoutSeconds, ...(checkId ? { verification: { mode: 'scoped', checkId, artifactPaths } } : {}) }, options.cwd ?? process.cwd()); notify(JSON.stringify(started));
    const result = await scheduler.wait(started.id); notify(JSON.stringify(result));
    return result.exitCode ?? (result.state === 'completed' ? 0 : 1);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); await scheduler.close(); }
}
