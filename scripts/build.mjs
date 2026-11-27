import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc'))], { stdio: 'inherit' });

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await build({
  entryPoints: ['src/local/main.ts'],
  outfile: 'dist/local/daemon.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@trusty-squire/mcp'],
  alias: { '@libsql/client': fileURLToPath(new URL('../src/local/bundled-sqlite.ts', import.meta.url)) },
  define: { GRUNT_DAEMON_BUNDLE: 'true', GRUNT_BUNDLED_VERSION: JSON.stringify(version) },
  banner: { js: "import { createRequire as gruntCreateRequire } from 'node:module'; const require = gruntCreateRequire(import.meta.url);" },
});

await mkdir('dist/registry', { recursive: true });
await mkdir('dist/admin-public', { recursive: true });
const adminFiles = (await readdir('site/admin')).filter(name => ['index.html', 'admin.css', 'admin.js'].includes(name) || name.startsWith('adoption.'));
await Promise.all([
  copyFile('registry/adapters.json', 'dist/registry/adapters.json'),
  ...adminFiles.map(name => copyFile(`site/admin/${name}`, `dist/admin-public/${name}`)),
  ...['site/grunt.svg', 'site/favicon.svg'].map(path => copyFile(path, `dist/${basename(path)}`)),
]);
