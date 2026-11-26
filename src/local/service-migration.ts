import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { configRoot } from '../brand.js';

export const legacyService = 'milo';

export function installedConfigRoot(env = process.env) {
  const current = configRoot(env);
  if (env.GRUNT_CONFIG_DIR || existsSync(current)) return current;
  const previous = join(dirname(current), legacyService);
  // Existing managed installations can keep their state at its original path.
  return existsSync(join(previous, 'runtime')) ? previous : current;
}

const oldPrefix = legacyService.toUpperCase() + '_';
const migratedSettings = ['PORT', 'CONFIG_DIR', 'SOURCES', 'DAEMON', 'OPENCODE_MODEL', 'OPENCODE_URL',
  'CODEX_MODEL', 'APP_TIMEOUT_MS', 'APP_POOL', 'SQUIRE_HOME', 'SQUIRE_XDG_CONFIG_HOME', 'SETUP_NO_HUMAN'];

export function migrateServiceEnvironment(env: NodeJS.ProcessEnv) {
  const settings = Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith(oldPrefix)
  ));
  for (const name of migratedSettings) {
    const previous = env[oldPrefix + name];
    if (previous !== undefined) settings['GRUNT_' + name] ??= previous;
  }
  return settings;
}

export const systemdQuote = (value: string, expandVariables = true) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', expandVariables ? '$$' : '$').replaceAll('\n', '\\n') + '"';
export const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const systemdEnvironment = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`, false)}`).join('\n');

export function launchAgent(name: string, node: string, entry: string, env: Record<string, string>) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.${name}.service</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>`;
}

type Run = (binary: string, args: string[]) => Promise<unknown>;
export async function bootoutService(run: Run, domain: string, label: string) {
  try { await run('launchctl', ['bootout', `${domain}/${label}`]); }
  catch {
    const listing = await run('launchctl', ['print', domain]);
    if (typeof listing !== 'string' || !listing.startsWith(domain + ' = {')
      || !/^\s*services = \{/m.test(listing) || listing.includes(label)) {
      throw new Error('Could not confirm the Grunt macOS service is stopped');
    }
  }
}

const dropInExtension = '.conf';
const maxFilenameBytes = 255;
const laterCharacters = ['0', 'A', 'a', '~', '\u07ff', '\ufffd', '\u{10fffd}'];
function laterDropInName(last: string) {
  const stem = last.slice(0, -dropInExtension.length);
  for (const ending of ['~grunt-migration.conf', '~.conf']) {
    const candidate = stem + ending;
    if (Buffer.byteLength(candidate) <= maxFilenameBytes) return candidate;
  }
  // A longer stem no longer fits. Increase a trailing character and discard
  // any characters after it, which keeps the name later in systemd's byte order.
  const characters = Array.from(stem);
  while (characters.length) {
    const current = characters.pop()!.codePointAt(0)!;
    const next = laterCharacters.find(character => character.codePointAt(0)! > current);
    if (!next) continue;
    const candidate = characters.join('') + next + dropInExtension;
    if (Buffer.byteLength(candidate) <= maxFilenameBytes) return candidate;
  }
}

export async function prepareServiceMigration(options: {
  platform: 'linux' | 'darwin'; file: string; node: string; entry: string;
  effective: Record<string, string>; original: NodeJS.ProcessEnv; enabled?: string; enableNew?: boolean; run: Run;
}) {
  const { platform, file, node, entry, effective, run, enabled } = options;
  const linux = platform === 'linux';
  const oldName = linux ? `${legacyService}.service` : `ai.${legacyService}.service.plist`;
  const newName = linux ? 'grunt.service' : 'ai.grunt.service.plist';
  const replacement = join(dirname(file), newName);
  if (basename(file) !== oldName || existsSync(replacement)) throw new Error('Cannot migrate the existing Grunt service while another identity is installed');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 262144) throw new Error('The existing Grunt service file is unsafe');
  const backup = join(dirname(file), `.${oldName}-${randomUUID()}`);
  const previousOverrides = file + '.d', replacementOverrides = replacement + '.d';
  const dropIns = linux && existsSync(previousOverrides);
  const replacementDropIns = linux && existsSync(replacementOverrides);
  if (dropIns && replacementDropIns) throw new Error('Both Grunt identities have service overrides');
  const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args]);
  const domain = `gui/${process.getuid!()}`;
  const enable = (name: string, state = enabled) => state === 'enabled' || state === 'enabled-runtime'
    ? systemctl('enable', ...(state === 'enabled-runtime' ? ['--runtime'] : []), name) : undefined;
  const env = { GRUNT_DAEMON: '1', ...effective };
  // Keep the unit directives and drop-ins. Supply the canonical settings that
  // previously came from the legacy environment aliases.
  const additions = Object.fromEntries(Object.entries(env).filter(
    ([name]) => name.startsWith('GRUNT_') && options.original[name] === undefined
  ));
  const environment = systemdEnvironment(additions);
  let translatedDropIn: { path: string; contents: string | Buffer; append: boolean } | undefined;
  if (linux && environment) {
    const localDirectory = dropIns ? previousOverrides : replacementDropIns ? replacementOverrides : undefined;
    if (localDirectory) {
      const info = await lstat(localDirectory);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('The existing Grunt service overrides are unsafe');
    }
    const active = await systemctl('show', oldName, '-p', 'DropInPaths', '--value');
    const activePaths = typeof active === 'string'
      ? [...active.matchAll(/(?:^|\s)(\/.*?\.conf)(?=\s|$)/g)].map(([, path]) => path!) : [];
    const localNames = localDirectory ? await readdir(localDirectory) : [];
    const names = [...activePaths.map(path => basename(path)), ...localNames];
    const last = names.filter(name => name.endsWith(dropInExtension)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).at(-1);
    // An empty Environment= clears earlier assignments, so write the translated values last.
    if (last) {
      const later = laterDropInName(last);
      const append = !later && localNames.includes(last);
      const inherited = !later && !append ? activePaths.find(path => basename(path) === last) : undefined;
      const settings = (later ? '' : '\n\n') + '[Service]\n' + environment + '\n';
      // At the end of the filename order, use the last file's own name. A
      // service-specific file with the same name takes precedence over an inherited one.
      translatedDropIn = {
        path: join(replacementOverrides, later ?? last),
        contents: inherited ? Buffer.concat([await readFile(inherited), Buffer.from(settings)]) : settings,
        append
      };
    }
  }
  const contents = linux ? await readFile(file, 'utf8') : launchAgent('grunt', node, entry, env);
  const unit = linux && environment && !translatedDropIn ? contents.trimEnd() + '\n\n[Service]\n' + environment + '\n' : contents;
  let installed = false, moved = false, movedDropIns = false, disabling = false, starting = false;
  let addedDropIn = false, createdDropInDirectory = false;
  let originalDropInSize: number | undefined;
  return {
    async apply() {
      if (linux) { disabling = true; await systemctl('disable', oldName); }
      await rename(file, backup);
      moved = true;
      await writeFile(replacement, unit, { flag: 'wx', mode: 0o600 });
      installed = true;
      if (dropIns) { await rename(previousOverrides, replacementOverrides); movedDropIns = true; }
      if (translatedDropIn) {
        if (!movedDropIns && !replacementDropIns) {
          await mkdir(replacementOverrides, { mode: 0o700 });
          createdDropInDirectory = true;
        }
        const handle = await open(translatedDropIn.path,
          translatedDropIn.append ? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK : 'wx', 0o600);
        try {
          if (translatedDropIn.append) {
            const info = await handle.stat();
            if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error('The last Grunt service override is unsafe');
            originalDropInSize = info.size;
          } else addedDropIn = true;
          await handle.writeFile(translatedDropIn.contents);
        } finally { await handle.close(); }
      }
      if (linux) { await systemctl('daemon-reload'); await enable(newName, options.enableNew ? 'enabled' : enabled); }
    },
    async start() {
      starting = true;
      if (linux) await systemctl('start', newName);
      else await run('launchctl', ['bootstrap', domain, replacement]);
    },
    async restore() {
      if (starting) {
        if (linux) await systemctl('stop', newName);
        else await bootoutService(run, domain, 'ai.grunt.service');
      }
      if (linux && installed) await systemctl('disable', newName);
      if (translatedDropIn && originalDropInSize !== undefined) {
        const handle = await open(translatedDropIn.path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { await handle.truncate(originalDropInSize); }
        finally { await handle.close(); }
      }
      if (addedDropIn && translatedDropIn) await rm(translatedDropIn.path);
      if (createdDropInDirectory) await rmdir(replacementOverrides);
      if (movedDropIns) await rename(replacementOverrides, previousOverrides);
      if (installed) await rm(replacement);
      if (moved) await rename(backup, file);
      if (linux && disabling) { await systemctl('daemon-reload'); await enable(oldName); }
    },
    async finish() { await rm(backup); }
  };
}
