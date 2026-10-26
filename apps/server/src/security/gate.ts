/**
 * Counting semaphore with a short, bounded FIFO wait queue: work waits at most `until` for a slot, at most
 * `maxWaiters` wait at once, and a released slot is handed to the oldest waiter (no barging). Beyond that the
 * caller gets its `busy` error (429): there is never an unbounded queue.
 */

/** Longest time ordinary work waits for a free slot before it is refused. */
export const MAX_WAIT_MS = 2000;

export interface GateWait {
  /** Epoch ms after which waiting stops with `busy()`. */
  until: number;
  signal?: AbortSignal | undefined;
  busy: () => Error;
  /** Error when `signal` aborts while waiting (defaults to `busy()`). */
  aborted?: () => Error;
}

interface Waiter { grant(release: () => void): void; fail(e: Error): void }

export class Gate {
  readonly max: number;
  readonly maxWaiters: number;
  #active = 0;
  readonly #waiters: Waiter[] = [];
  constructor(max: number, maxWaiters = max * 4) {
    this.max = max;
    this.maxWaiters = maxWaiters;
  }
  get active(): number { return this.#active; }
  get waiting(): number { return this.#waiters.length; }
  get idle(): boolean { return this.#active === 0 && this.#waiters.length === 0; }

  /** A slot now, or null (never jumps ahead of waiters). */
  tryAcquire(): (() => void) | null {
    if (this.#active >= this.max || this.#waiters.length) return null;
    this.#active++;
    return this.#releaser();
  }

  acquire(o: GateWait): Promise<() => void> {
    if (o.signal?.aborted) return Promise.reject((o.aborted ?? o.busy)());
    const now = this.tryAcquire();
    if (now) return Promise.resolve(now);
    const ms = o.until - Date.now();
    if (ms <= 0 || this.#waiters.length >= this.maxWaiters) return Promise.reject(o.busy());
    return new Promise((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', abort);
        const i = this.#waiters.indexOf(w);
        if (i >= 0) this.#waiters.splice(i, 1);
      };
      const w: Waiter = {
        grant: (release) => { leave(); resolve(release); },
        fail: (e) => { leave(); reject(e); },
      };
      const timer = setTimeout(() => w.fail(o.busy()), ms);
      const abort = () => w.fail((o.aborted ?? o.busy)());
      o.signal?.addEventListener('abort', abort, { once: true });
      this.#waiters.push(w);
    });
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiters[0];
      // Hand the slot straight to the oldest waiter; the active count stays the same.
      if (next) next.grant(this.#releaser());
      else this.#active--;
    };
  }
}

/** One gate per key (e.g. per user), dropped again when idle so the map stays bounded by active keys. */
export class KeyedGates {
  readonly max: number;
  readonly #gates = new Map<string, Gate>();
  constructor(max: number) { this.max = max; }
  async acquire(key: string, o: GateWait): Promise<() => void> {
    let g = this.#gates.get(key);
    if (!g) this.#gates.set(key, (g = new Gate(this.max)));
    const gate = g;
    const forget = () => { if (gate.idle && this.#gates.get(key) === gate) this.#gates.delete(key); };
    try {
      const release = await gate.acquire(o);
      return () => { release(); forget(); };
    } catch (e) {
      forget();
      throw e;
    }
  }
  get size(): number { return this.#gates.size; }
}
