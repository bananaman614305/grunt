import { expect, it } from 'vitest';
import { nousApprovalURL } from './nous-setup.js';

it('accepts the official Hermes device approval link', () => {
  const url = 'https://portal.nousresearch.com/manage-subscription?user_code=TEST-1234';
  expect(nousApprovalURL(`  1. Open: ${url}`)?.href).toBe(url);
});

it.each([
  'https://example.test/manage-subscription?user_code=TEST-1234',
  'https://portal.nousresearch.com/anything?user_code=TEST-1234',
  'https://portal.nousresearch.com/manage-subscription?user_code=TEST-1234&paid=true',
  'https://portal.nousresearch.com/manage-subscription?user_code=WRONG'
])('rejects a different approval target', url => {
  expect(nousApprovalURL(`  1. Open: ${url}`)).toBeUndefined();
});
