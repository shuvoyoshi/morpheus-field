/**
 * A bounded LRU cache over a Map (insertion order is the eviction order).
 * Used for the server's per-token caches (input probes, scene plans), which
 * used to grow without bound on a long-lived server.
 */
export class Lru<K, V> {
  private m = new Map<K, V>();
  private max: number;
  constructor(cap = 256) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error('Lru cap must be a positive integer');
    this.max = cap;
  }
  get cap(): number {
    return this.max;
  }
  get size(): number {
    return this.m.size;
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  /** A hit refreshes recency. */
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
  delete(k: K): boolean {
    return this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  keys(): Iterator<K> {
    return this.m.keys();
  }
}
