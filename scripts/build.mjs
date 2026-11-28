import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
// The write-only PostHog project key for release builds (docs/router.md#4-usage-telemetry).
const posthogKey = process.env.POSTHOG_PROJECT_KEY?.trim() ?? '';
if (posthogKey && !/^phc_[A-Za-z0-9_-]+$/.test(posthogKey)) throw new Error('POSTHOG_PROJECT_KEY must be a PostHog project key (phc_...)');
async function bundleDaemon(outfile) {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/local/main.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['@trusty-squire/mcp'],
    alias: {
      '@libsql/client': fileURLToPath(new URL('../src/local/bundled-sqlite.ts', import.meta.url)),
      'jsonc-parser': fileURLToPath(import.meta.resolve('jsonc-parser/lib/esm/main.js')),
    },
    define: { GRUNT_DAEMON_BUNDLE: 'true', GRUNT_BUNDLED_VERSION: JSON.stringify(version), GRUNT_POSTHOG_KEY: JSON.stringify(posthogKey) },
    banner: { js: "import { createRequire as gruntCreateRequire } from 'node:module'; const require = gruntCreateRequire(import.meta.url);" },
  });
}

if (process.argv[2] === '--daemon-only') {
  const outfile = process.argv[3];
  if (!outfile) throw new Error('Usage: node scripts/build.mjs --daemon-only <outfile>');
  await bundleDaemon(outfile);
  process.exit(0);
}

await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc'))], { stdio: 'inherit' });
// The CLI (usegrunt setup) runs the tsc output, so it gets the key as a module.
if (posthogKey) await writeFile('dist/local/telemetry-key.js', `export const POSTHOG_KEY = ${JSON.stringify(posthogKey)};\n`);
await bundleDaemon('dist/local/daemon.mjs');

await mkdir('dist/registry', { recursive: true });
await copyFile('registry/adapters.json', 'dist/registry/adapters.json');
