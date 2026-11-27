import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonFile } from './daemon-files.js';
import { openPrivateFile } from './private-file.js';

type Run = (command: string, args: string[]) => Promise<string>;
const launcher = 'launch.mjs';
const prefix = 'const environment = ';
export const taskScheduler = 'schtasks.exe';
const taskName = (directory: string) => 'Grunt-' + createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex').slice(0, 16);
const runtime = (directory: string) => join(directory, 'runtime');
const argumentsFor = (directory: string) => `"${join(runtime(directory), launcher)}"`;
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function writeWindowsLauncher(target: string, env: Record<string, string>) {
  const path = join(target, launcher), temporary = join(target, `.${launcher}-${randomUUID()}`);
  const daemonImport = JSON.stringify('./' + daemonFile);
  const script = `${prefix}${JSON.stringify(env)};\nObject.assign(process.env, environment);\nconst { start } = await import(${daemonImport});\nstart();\n`;
  try {
    await writeFile(temporary, script, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function launcherEnvironment(directory: string): Promise<Record<string, string>> {
  const file = await openPrivateFile(join(runtime(directory), launcher), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('The Grunt task launcher is unsafe');
    const line = (await file.readFile('utf8')).split('\n')[0] ?? '';
    if (!line.startsWith(prefix) || !line.endsWith(';')) throw new Error('The Grunt task launcher is invalid');
    const env = JSON.parse(line.slice(prefix.length, -1)) as Record<string, string>;
    if (!env || env.GRUNT_CONFIG_DIR !== directory || Object.values(env).some(value => typeof value !== 'string')) throw new Error('The existing Grunt task uses a different configuration directory');
    return env;
  } finally { await file.close(); }
}

interface Task { state: number; node: string; args: string; limited: boolean }
async function query(directory: string, run: Run): Promise<Task | undefined> {
  // The Scheduler API exposes numeric states on every Windows display language.
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "$service = New-Object -ComObject 'Schedule.Service'",
    '$service.Connect()',
    `$task = $service.GetFolder('\\').GetTasks(1) | Where-Object { $_.Name -eq '${taskName(directory)}' }`,
    'if ($task) {',
    '  $definition = $task.Definition',
    '  $action = $definition.Actions.Item(1)',
    '  [pscustomobject]@{ state = [int]$task.State',
    '    node = $action.Path',
    '    args = $action.Arguments',
    '    limited = ($definition.Principal.RunLevel -eq 0 -and $definition.Principal.LogonType -eq 3 -and $definition.Actions.Count -eq 1)',
    '  } | ConvertTo-Json -Compress',
    '}'
  ];
  const result = (await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', lines.join('\n')])).trim();
  if (!result) return;
  const task = JSON.parse(result) as Task;
  if (!task.limited || typeof task.node !== 'string' || !isAbsolute(task.node) || !/^node(?:\.exe)?$/i.test(basename(task.node))
    || task.args !== argumentsFor(directory) || ![1, 2, 3, 4].includes(task.state)) throw new Error('The existing Windows task does not use the managed Grunt launcher');
  return task;
}

export async function windowsService(directory: string, run: Run) {
  const task = await query(directory, run);
  if (!task) return;
  return { identity: taskName(directory), node: task.node, state: task.state, environment: await launcherEnvironment(directory) };
}

export async function stopWindowsService(directory: string, run: Run) {
  const idle = (task: Task | undefined) => task !== undefined && (task.state === 1 || task.state === 3);
  if (idle(await query(directory, run))) return;
  await run(taskScheduler, ['/end', '/tn', taskName(directory)]);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (idle(await query(directory, run))) return;
    await delay(250);
  }
  throw new Error('Could not confirm the Grunt Windows task is stopped');
}

export async function startWindowsService(directory: string, run: Run) {
  await run(taskScheduler, ['/run', '/tn', taskName(directory)]);
}

export async function removeWindowsService(directory: string, run: Run) {
  if (await query(directory, run)) await run(taskScheduler, ['/delete', '/tn', taskName(directory), '/f']);
}

export async function registerWindowsService(directory: string, run: Run) {
  const sid = (await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'])).match(/"\s*,\s*"(S-1-(?:\d+-)*\d+)"\s*$/)?.[1];
  if (!sid) throw new Error('Could not determine the Windows user for the Grunt task');
  // Separate the executable and arguments and remove Task Scheduler's default
  // time and battery limits. Logon and limited privileges match /sc onlogon /rl limited.
  const definition = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="GruntUser"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="GruntUser"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(argumentsFor(directory))}</Arguments><WorkingDirectory>${xml(directory)}</WorkingDirectory></Exec></Actions>
</Task>`;
  const path = join(runtime(directory), `.task-${randomUUID()}.xml`);
  try {
    await writeFile(path, '\ufeff' + definition, { encoding: 'utf16le', mode: 0o600, flag: 'wx' });
    await run(taskScheduler, ['/create', '/tn', taskName(directory), '/xml', path, '/f']);
  } finally { await rm(path, { force: true }); }
}
