export type LayerDemand<T> = { key: string; value: T };

// Keep one in-flight operation across priority/visibility changes. A withdrawn
// operation may finish, but disposal prevents it from publishing to a new scene.
export class LayerDemandQueue<T> {
  private demand = new Map<string, T>();
  private attempted = new Set<string>();
  private running: string | null = null;
  private disposed = false;

  constructor(
    private execute: (value: T, key: string, isActive: () => boolean) => Promise<void | "retry">,
    private onError: (error: unknown, key: string) => void,
  ) {}

  update(items: readonly LayerDemand<T>[]) {
    if (this.disposed) return;
    this.demand = new Map(items.map(item => [item.key, item.value]));
    for (const key of this.attempted) if (!this.demand.has(key) && key !== this.running) this.attempted.delete(key);
    void this.drain();
  }

  hasDemand(key: string) { return !this.disposed && this.demand.has(key); }
  get pendingCount() { return Number(this.running !== null) + [...this.demand.keys()].filter(key => !this.attempted.has(key)).length; }

  dispose() {
    this.disposed = true;
    this.demand.clear();
    this.attempted.clear();
  }

  private async drain() {
    if (this.running !== null || this.disposed) return;
    while (!this.disposed) {
      const next = [...this.demand].find(([key]) => !this.attempted.has(key));
      if (!next) return;
      const [key, value] = next;
      this.running = key;
      this.attempted.add(key);
      try {
        // A withdrawn or evicted result did not satisfy this demand. Retrying
        // after it finishes preserves serial loading and a rapid reentry.
        if (await this.execute(value, key, () => !this.disposed) === "retry") this.attempted.delete(key);
      }
      catch (error) { if (!this.disposed) this.onError(error, key); }
      finally {
        this.running = null;
        if (!this.demand.has(key)) this.attempted.delete(key);
      }
    }
  }
}
