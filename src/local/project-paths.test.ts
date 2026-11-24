import { expect, it } from 'vitest';
import { privateProjectPath } from './project-paths.js';

it('recognizes credential, VCS and private tool paths at any depth', () => {
  for (const path of ['.GIT/config', 'src/.env.local', 'src/credentials-prod.json', '.grunt-workspace-test.proof', 'a/node_modules/x', 'k/id_ed25519', 'cert.PEM']) expect(privateProjectPath(path), path).toBe(true);
  expect(privateProjectPath('src/CREDENTIALS')).toBe(true); expect(privateProjectPath('src/app.ts')).toBe(false);
});
