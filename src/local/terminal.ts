// Interactive child processes (for example sudo) and browser confirmations
// must never read stdin at the same time. Noninteractive jobs stay concurrent.
let tail: Promise<unknown> = Promise.resolve();
export function withTerminal<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task);
  tail = result.catch(() => {});
  return result;
}
