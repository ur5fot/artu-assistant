/**
 * Background connect-retry loop for the Discord primary connection (root #2).
 *
 * The first connect attempt is made inline at bootstrap (fast path). When it
 * fails — a flapping VPN/DNS means Discord login can't even reach the gateway —
 * we must NOT leave R2 channel-less until a manual restart. Instead we start a
 * detached loop that keeps retrying `connect()` with exponential backoff (capped,
 * jittered) until it succeeds, then runs `onConnect` exactly once. The loop never
 * gives up on its own; it stops only when the returned `stop()` is called
 * (shutdown). An established session is reconnected by discord.js itself
 * (shardResume) — this loop only covers the *initial* connect.
 */

export interface ReconnectLoopDeps<T> {
  /** Attempt a connect. Rejects on transient failure; the loop retries. */
  connect: () => Promise<T>;
  /** Run once on the first successful connect (e.g. register gated handlers). */
  onConnect: (result: T) => void | Promise<void>;
  /** Backoff floor in ms (first retry waits ~baseMs). */
  baseMs: number;
  /** Backoff ceiling in ms (waits never exceed capMs + jitter). */
  capMs: number;
  /** Progress logger. Defaults to a no-op. */
  log?: (msg: string, err: unknown) => void;
  /** Injectable sleep (tests pass an immediate/controlled version). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1). Defaults to Math.random. */
  jitter?: () => number;
}

/** Exponential backoff with full jitter, clamped to [0, capMs] before jitter. */
export function computeBackoff(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitter = Math.random,
): number {
  const exp = baseMs * 2 ** attempt;
  const capped = Math.min(capMs, exp);
  // Full jitter: spread [0, capped] so reconnecting clients don't thunder.
  return Math.round(capped * jitter());
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the retry loop in the background. Returns a `stop()` function that halts
 * the loop after its current await (idempotent). Does NOT block — returns
 * synchronously while the loop runs detached, so bootstrap continues degraded.
 */
export function startReconnectLoop<T>(deps: ReconnectLoopDeps<T>): () => void {
  const { connect, onConnect, baseMs, capMs } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const jitter = deps.jitter ?? Math.random;

  let stopped = false;

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      // Only the connect() call is retryable — a transient network failure is
      // expected and we back off and try again. onConnect() runs OUTSIDE this
      // try: if handler registration throws it must NOT be misread as a connect
      // failure. Doing so would retry connect() (leaking the just-connected bot),
      // and since guardOnce latches on the first call, registration would then be
      // skipped on every later success — channel live, proactive handlers dead,
      // silently. Instead we let an onConnect failure reject this loop so the
      // process-level net surfaces it (real bug → exit → supervisor restart),
      // mirroring the fast-path policy in index.ts.
      let result: T;
      try {
        result = await connect();
      } catch (err) {
        if (stopped) return;
        const wait = computeBackoff(attempt, baseMs, capMs, jitter);
        log(`[discord] reconnect attempt ${attempt + 1} failed, retrying in ${wait}ms`, err);
        attempt += 1;
        await sleep(wait);
        continue;
      }
      if (stopped) return; // shut down while connecting — drop the result
      await onConnect(result); // failures surface (not retried as connect)
      return; // connected + registered once; loop is done
    }
  })();

  return () => {
    stopped = true;
  };
}

/**
 * Wrap a side-effecting function so it runs at most once, regardless of how many
 * times it's invoked (fast-path success AND a later background reconnect both
 * call the registrar; only the first takes effect).
 */
export function guardOnce<A extends unknown[]>(
  fn: (...args: A) => void | Promise<void>,
): (...args: A) => Promise<void> {
  let done = false;
  return async (...args: A) => {
    if (done) return;
    done = true;
    await fn(...args);
  };
}
