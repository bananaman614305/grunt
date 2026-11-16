// Interactive child processes (for example sudo) and browser confirmations
// must never read stdin at the same time. Noninteractive jobs stay concurrent.
let tail: Promise<unknown> = Promise.resolve();
let active = false;
const observers = new Set<(busy: boolean) => void>();
export const terminalBusy = () => active;
// Status displays may observe terminal ownership, but never receive the prompt,
// browser capability link, or any data entered by the user.
export function observeTerminal(observer: (busy: boolean) => void) {
  observers.add(observer);
  try { observer(active); } catch { /* A display cannot block confirmation. */ }
  return () => { observers.delete(observer); };
}
function changed(busy: boolean) {
  active = busy;
  for (const observer of observers) {
    try { observer(busy); } catch { /* Observability is independent of setup. */ }
  }
}
export function withTerminal<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(async () => {
    changed(true);
    try { return await task(); }
    finally { changed(false); }
  });
  tail = result.catch(() => {});
  return result;
}
