import { AsyncLocalStorage } from 'node:async_hooks';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import { SourceError } from './source.js';
import type { ErrorCode } from './source.js';

import { TRANSIENT_RETRY_WINDOW_SECONDS } from './retry-window.js';
export { TRANSIENT_RETRY_WINDOW_SECONDS };

export type ProviderFailureCause =
  | 'transient'
  | 'exhausted'
  | 'auth_invalid'
  | 'banned'
  | 'offer_ended'
  | 'unconfigured';

export const providerFailureCauses = new Set<ProviderFailureCause>([
  'transient',
  'exhausted',
  'auth_invalid',
  'banned',
  'offer_ended',
  'unconfigured'
]);

export function classifyHttpStatus(
  status: number,
  options: { retryAfter?: number; paymentAsRefusal?: boolean } = {}
): { code: ErrorCode; cause: ProviderFailureCause } {
  if (status === 401) return { code: 'logged_out', cause: 'auth_invalid' };
  if (status === 402) {
    return options.paymentAsRefusal
      ? { code: 'refused', cause: 'banned' }
      : { code: 'quota', cause: 'exhausted' };
  }
  if (status === 403) return { code: 'refused', cause: 'banned' };
  if (status === 429) {
    const short = options.retryAfter !== undefined && Number.isFinite(options.retryAfter) && options.retryAfter <= TRANSIENT_RETRY_WINDOW_SECONDS;
    return { code: 'quota', cause: short ? 'transient' : 'exhausted' };
  }
  return { code: 'upstream', cause: 'transient' };
}

export function classifyHttpFailure(options: {
  source: string;
  status: number;
  message?: string;
  retryAfter?: number;
  paymentAsRefusal?: boolean;
  endpointLabel?: SafeDiagnosticMetadata['endpointLabel'];
  httpMethod?: SafeDiagnosticMetadata['httpMethod'];
  failureReason?: SafeDiagnosticMetadata['failureReason'];
}): SourceError {
  const { code, cause } = classifyHttpStatus(options.status, {
    ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter }),
    ...(options.paymentAsRefusal === undefined ? {} : { paymentAsRefusal: options.paymentAsRefusal })
  });
  const diagnostics: SafeDiagnosticMetadata = {
    httpStatus: options.status,
    transport: 'http',
    ...(options.endpointLabel ? { endpointLabel: options.endpointLabel } : {}),
    ...(options.httpMethod ? { httpMethod: options.httpMethod } : {}),
    ...(options.failureReason ? { failureReason: options.failureReason } : {})
  };
  const error = new SourceError(
    code,
    options.message ?? `${options.source} returned HTTP ${options.status}`,
    options.retryAfter,
    undefined,
    diagnostics
  );
  error.failureCause = cause;
  return error;
}

export function classifySourceError(error: unknown): ProviderFailureCause {
  if (error instanceof SourceError) {
    if (error.failureCause) return error.failureCause;
    const status = error.diagnostics?.httpStatus;
    if (status === 401) return 'auth_invalid';
    if (status === 403) return 'banned';
    if (status === 402) return error.code === 'refused' ? 'banned' : 'exhausted';
    if (error.code === 'not_installed') return 'unconfigured';
    if (error.code === 'logged_out') return 'auth_invalid';
    if (error.code === 'quota') {
      return error.retryAfter !== undefined && Number.isFinite(error.retryAfter) && error.retryAfter <= TRANSIENT_RETRY_WINDOW_SECONDS
        ? 'transient'
        : 'exhausted';
    }
    if (error.code === 'refused') {
      if (/\b(?:expired|retired|promotion ended|offer ended|no longer lists)\b/i.test(error.message)) return 'offer_ended';
      if (/\b(?:not approved|consent)\b/i.test(error.message)) return 'unconfigured';
      return 'banned';
    }
    return 'transient';
  }
  return 'transient';
}

export function formatResetCountdown(seconds: number): string {
  const value = Math.max(1, Math.ceil(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.ceil(value / 60)}m`;
  return `${Math.ceil(value / 3600)}h`;
}

// Lets adapters record the specific typed cause when available() catches an error
// and returns false, so status and recovery see why the route is unavailable.
interface AvailabilityFailureSlot { error?: SourceError }
const availabilityFailureStorage = new AsyncLocalStorage<AvailabilityFailureSlot>();

export function withAvailabilityFailureCapture<T>(work: (slot: AvailabilityFailureSlot) => Promise<T>): Promise<T> {
  const slot: AvailabilityFailureSlot = {};
  return availabilityFailureStorage.run(slot, () => work(slot));
}

export function observeAvailabilityFailure(error: unknown): void {
  const slot = availabilityFailureStorage.getStore();
  if (!slot) return;
  if (error instanceof SourceError) {
    if (error.code === 'cancelled') return;
    if (!error.failureCause) error.failureCause = classifySourceError(error);
    slot.error = error;
  }
}
