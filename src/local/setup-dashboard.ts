import { startDashboard, statusCommand } from './dashboard.js';
import { observeTerminal, terminalBusy } from './terminal.js';

export interface SetupDashboard { stop(): Promise<void> }
export function setupDashboardEnabled() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb'
    && process.env.MILO_SETUP_NO_HUMAN !== '1');
}

// During onboarding this display is passive: the existing confirmation queue
// owns stdin. A terminal lease restores the main screen before any prompt.
export function startSetupDashboard(options: { port: number; signal: AbortSignal; approvals: () => readonly string[] }): SetupDashboard | undefined {
  if (!setupDashboardEnabled()) return;
  const display = startDashboard({ ...options, interactive: false, setup: true, isSuspended: terminalBusy });
  const unsubscribe = observeTerminal(busy => { if (busy) display.pause(); else display.resume(); });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { unsubscribe(); await display.stop(); })();
  // Signal handling belongs to the renderer; release our observation too when
  // it ends independently, so an old view cannot resume on a later prompt.
  void display.done.then(unsubscribe, unsubscribe);
  return { stop };
}

export async function watchSetupDashboard(port: number) {
  if (setupDashboardEnabled()) await statusCommand(['--watch', '--port', String(port)]);
}
