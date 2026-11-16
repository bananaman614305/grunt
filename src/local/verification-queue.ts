export interface Verification { service: string; url: string; goal?: string }
// Group handoffs arriving together; only one terminal prompt may own stdin.
// Other installation/browser jobs keep running while the user verifies.
export class VerificationQueue {
  private pending: { item: Verification; resolve(): void; reject(error: unknown): void }[] = [];
  private running = false;
  private active: Verification[] = [];
  private observers = new Set<(services: readonly string[]) => void>();
  constructor(private confirm: (items: Verification[]) => Promise<void>) {}
  services(): readonly string[] {
    // This safe projection deliberately excludes URLs and requested goals.
    return [...new Set([...this.active, ...this.pending.map(entry => entry.item)]
      .map(item => item.service).filter(service => /^[a-z0-9][a-z0-9-]{0,63}$/.test(service)))];
  }
  subscribe(observer: (services: readonly string[]) => void) {
    this.observers.add(observer);
    try { observer(this.services()); } catch { /* Status cannot stop approval. */ }
    return () => { this.observers.delete(observer); };
  }
  private changed() {
    for (const observer of this.observers) {
      try { observer(this.services()); } catch { /* Isolate display failures. */ }
    }
  }
  wait(item: Verification): Promise<void> {
    const result = new Promise<void>((resolve, reject) => this.pending.push({ item, resolve, reject }));
    this.changed();
    if (!this.running) { this.running = true; setImmediate(() => { void this.drain(); }); }
    return result;
  }
  private async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      this.active = batch.map(entry => entry.item);
      this.changed();
      try { await this.confirm(this.active); batch.forEach(entry => entry.resolve()); }
      catch (error) { [...batch, ...this.pending.splice(0)].forEach(entry => entry.reject(error)); }
      finally { this.active = []; this.changed(); }
    }
    this.running = false;
  }
}
