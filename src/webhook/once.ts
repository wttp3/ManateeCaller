const inflight = new Map<string, Promise<void>>();

/**
 * Run `work` once per event key inside this process.
 * Concurrent callers share the same promise, so a duplicate forward cannot
 * pass the "is this new?" check before the first insert lands.
 */
export function runWebhookOnce(eventKey: string, work: () => Promise<void>): Promise<void> {
  const existing = inflight.get(eventKey);
  if (existing) {
    return existing;
  }
  const promise = work().finally(() => {
    if (inflight.get(eventKey) === promise) {
      inflight.delete(eventKey);
    }
  });
  inflight.set(eventKey, promise);
  return promise;
}

export function resetWebhookLocks(): void {
  inflight.clear();
}
