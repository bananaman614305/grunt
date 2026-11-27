import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
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
    define: { GRUNT_DAEMON_BUNDLE: 'true', GRUNT_BUNDLED_VERSION: JSON.stringify(version) },
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
await bundleDaemon('dist/local/daemon.mjs');

await mkdir('dist/registry', { recursive: true });
await mkdir('dist/admin-public', { recursive: true });
const adminFiles = (await readdir('site/admin')).filter(name => ['index.html', 'admin.css', 'admin.js'].includes(name) || name.startsWith('adoption.'));
await Promise.all([
  copyFile('registry/adapters.json', 'dist/registry/adapters.json'),
  ...adminFiles.map(name => copyFile(`site/admin/${name}`, `dist/admin-public/${name}`)),
  ...['site/grunt.svg', 'site/favicon.svg'].map(path => copyFile(path, `dist/${basename(path)}`)),
]);
