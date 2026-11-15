export function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Serialises every request that shares one external service budget. The queue is
 * shared by all workers, so the service limit holds no matter how many tracks are
 * processed in parallel.
 */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve()
  private lastStarted = 0

  constructor(private readonly minIntervalMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastStarted + this.minIntervalMs - Date.now()
      if (wait > 0) await delay(wait)
      try {
        return await task()
      } finally {
        this.lastStarted = Date.now()
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export async function retry<T>(task: () => Promise<T>, attempts = 3, backoffMs = 750): Promise<T> {
  let error: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task()
    } catch (failure) {
      error = failure
      if (attempt + 1 < attempts) await delay(backoffMs * (attempt + 1))
    }
  }
  throw error
}

/** Runs a bounded worker pool over a list, preserving result order. */
export async function runPool<T, R>(
  items: readonly T[],
  workers: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(workers, items.length))
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }))
  return results
}
