import { SourceError } from './source.js';

// Setup can display these fixed messages on screen and in local logs. Upstream
// error text is only matched in memory and is never copied into either output.
export function setupFailureReason(error: unknown): string {
  if (error instanceof SourceError) {
    return { quota: 'quota exhausted', refused: 'provider refused', logged_out: 'sign-in required',
      not_installed: 'required software unavailable', timeout: 'timed out', cancelled: 'cancelled', upstream: 'provider request failed' }[error.code];
  }
  if (!(error instanceof Error)) return 'setup failed';
  if (/\b(?:EPERM|EACCES|EROFS)\b|read.only file system/i.test(error.message)) return 'configuration write blocked';
  if (/no (?:eligible|tool-capable) adapter|model pool unavailable/i.test(error.message)) return 'model pool unavailable';
  if (/quota|free usage limit|\b429\b/i.test(error.message)) return 'quota exhausted';
  if (/\b(?:refused|denied)\b/i.test(error.message)) return 'provider refused';
  if (/Nous login needs you/.test(error.message)) return 'needs Nous login';
  if (/requires? .*approval/i.test(error.message)) return 'approval required';
  if (/needs? uv or Python/i.test(error.message)) return 'requires uv or a newer Python';
  if (/\b(?:not signed in|logged out|authentication|unauthorized|sign-in required)\b/i.test(error.message)) return 'sign-in required';
  if (/\b(?:timed out|timeout|did not answer)\b/i.test(error.message)) return 'timed out';
  if (/Squire .*unavailable|repair the broker|Connect Trusty Squire/i.test(error.message)) return 'Squire unavailable';
  if (/no verified Kilo credential/i.test(error.message)) return 'no verified Kilo credential';
  if (/release checksum|package integrity/i.test(error.message)) return 'download failed integrity check';
  if (/release download|package download/i.test(error.message)) return 'download failed';
  if (/native .*pairing|native login/i.test(error.message)) return 'native CLI pairing incomplete';
  if (/Clixad free native setup did not complete/i.test(error.message)) return 'free native setup incomplete';
  if (/printed no answer/i.test(error.message)) return 'empty reply';
  if (/Could not run/i.test(error.message)) return 'CLI unavailable';
  if (/exited with code/i.test(error.message)) return 'CLI request failed';
  return 'setup failed';
}

export function signupOperatorUnavailable(reason: string) {
  return ['quota exhausted', 'model pool unavailable', 'CLI unavailable', 'sign-in required'].includes(reason);
}

export function setupAttention(reason: string) {
  switch (reason) {
    case 'needs Terms of Service acceptance': return 'review the Terms of Service in the browser';
    case 'needs human verification': return 'complete verification in the browser';
    case 'needs SMS verification': return 'complete SMS verification in the browser';
    case 'browser requested an approval': return 'review the browser approval';
    case 'native CLI pairing incomplete': return 'complete the native CLI pairing';
    case 'needs Nous login': return 'Nous login';
  }
}
