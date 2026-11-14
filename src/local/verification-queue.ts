export interface Verification { service: string; url: string }
// Group handoffs arriving together; only one terminal prompt may own stdin.
// Other installation/browser jobs keep running while the user verifies.
export class VerificationQueue {
  private pending: { item: Verification; resolve(): void; reject(error: unknown): void }[] = [];
  private running = false;
  constructor(private confirm: (items: Verification[]) => Promise<void>) {}
  wait(item: Verification): Promise<void> {
    const result = new Promise<void>((resolve, reject) => this.pending.push({ item, resolve, reject }));
    if (!this.running) { this.running = true; setImmediate(() => { void this.drain(); }); }
    return result;
  }
  private async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      try { await this.confirm(batch.map(entry => entry.item)); batch.forEach(entry => entry.resolve()); }
      catch (error) { [...batch, ...this.pending.splice(0)].forEach(entry => entry.reject(error)); }
    }
    this.running = false;
  }
}
