// Serializes async start/stop style operations ("last request wins").
// No electron import (testable with plain node).

/**
 * Runs operations one after another. An operation that has not started yet when a newer one is
 * queued is skipped; its caller gets the result of the newest operation instead. So a burst of
 * start/stop/restart requests ends in the state of the last request, and two operations never
 * overlap (no orphaned child processes / listening sockets).
 */
export class LatestQueue<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private newest: Promise<{ value: T } | null> = Promise.resolve(null);

  run(op: () => Promise<T> | T): Promise<T> {
    const id = ++this.seq;
    const link = this.tail.then(async () => (id === this.seq ? { value: await op() } : null));
    this.tail = link.catch(() => undefined);
    this.newest = link;
    return link.then((r) => (r ? r.value : this.settled()));
  }

  /** Resolves with the result of the newest operation once the queue is idle. */
  private async settled(): Promise<T> {
    for (;;) {
      const p = this.newest;
      const r = await p;
      if (p !== this.newest) continue; // an even newer op was queued meanwhile -> wait for that one
      if (r) return r.value;
      throw new Error('LatestQueue: newest operation was skipped'); // cannot happen (newest never skips)
    }
  }
}
