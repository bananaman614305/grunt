import { expect, it } from 'vitest';
import { privateProjectPath, projectRelativePath } from './project-paths.js';

it('accepts portable relative paths and rejects private, absolute or traversing ones', () => {
  expect(projectRelativePath('src/')).toBe('src'); expect(projectRelativePath('.', true)).toBe('');
  for (const path of ['/etc/passwd', '../file', 'src/../../x', 'src//a', './src', 'a\\b', 'src/a:secret', 'src/a.', 'src/a ', 'con.txt', 'src/COM1', '.GIT/config', 'src/.env.local', 'src/credentials-prod.json', '.grunt-workspace-test.proof']) expect(() => projectRelativePath(path), path).toThrow();
  expect(privateProjectPath('src/CREDENTIALS')).toBe(true); expect(privateProjectPath('src/app.ts')).toBe(false);
});
