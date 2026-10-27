/**
 * Review v0.4 r2 graph H2: FalkorDB checks its TIMEOUT between steps, so one expression can run for seconds or minutes
 * after the console has answered, and closing the socket does not stop it. The console therefore holds a graph query's
 * slots until the engine answers: one per user and GRAPH_ENGINE_SLOTS_PER_DB per database.
 */
import { describe, expect, it } from 'vitest';
import type { AppContext, DbScope } from '../../src/context.ts';
import { HttpError } from '../../src/http/errors.ts';
import { classify } from '../../src/policy/policy.ts';
import { execute, GRAPH_ENGINE_SLOTS_PER_DB, type Prepared } from '../../src/routes/cli.ts';
import { Slots } from '../../src/security/ratelimit.ts';

/** A connection whose replies are released by the test. */
function engine() {
  const pending: { argv: string[]; answer: (v: unknown) => void; opts: Record<string, unknown> }[] = [];
  const conn = {
    send: (args: Buffer[], opts: Record<string, unknown>) =>
      new Promise((answer) => pending.push({ argv: args.map(String), answer, opts })),
  };
  /** Resolves once `n` commands have been sent (the send follows an awaited connection). */
  const sent = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 1)); };
  return { conn, pending, sent };
}
const ctx = (slots: Slots) => ({ slots, config: { policy: { maxReplyBytes: 1 << 20, commandTimeoutMs: 40 } } }) as unknown as AppContext;
const scope = (userId: string, conn: unknown, db = 'graph', poolSize = 4) => ({ session: { userId }, db: { id: db, poolSize }, role: 'viewer', conn: async () => conn }) as unknown as DbScope;
const prepared = (argv: string[]): Prepared => ({ argv: argv.map((a) => Buffer.from(a)), c: classify(argv, undefined), confirmSpec: null });
const query = prepared(['GRAPH.RO_QUERY', 'g', 'RETURN 1', 'TIMEOUT', '1000']);

describe('graph queries hold their slots until FalkorDB answers (review v0.4 r2 graph H2)', () => {
  it('answers 504 at the console timeout but keeps the user and database slots until the engine replies', async () => {
    const slots = new Slots();
    const { conn, pending, sent } = engine();
    const first = execute(ctx(slots), scope('u1', conn), query).catch((e: unknown) => e);
    const err = await first;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('timeout');
    expect((err as HttpError).message).toMatch(/still running/);
    // The engine is still busy: the same user cannot add another graph query.
    const again = await execute(ctx(slots), scope('u1', conn), query).catch((e: unknown) => e);
    expect((again as HttpError).code).toBe('rate_limited');
    expect(pending).toHaveLength(1);
    // The engine's socket carries no abort and a long timeout, so its answer is observed.
    expect(pending[0]!.opts.signal).toBeUndefined();
    expect(Number(pending[0]!.opts.timeout)).toBeGreaterThan(60_000);
    pending[0]!.answer([['a'], [[1]], ['Query internal execution time: 1 ms']]);
    await new Promise((r) => setTimeout(r, 0));
    const third = execute(ctx(slots), scope('u1', conn), query);
    await sent(2);
    pending[1]!.answer([['a'], [[1]], []]);
    expect((await third).reply).toBeDefined();
  });

  it('at most GRAPH_ENGINE_SLOTS_PER_DB graph queries per database run in the engine at once, across users', async () => {
    const slots = new Slots();
    const { conn, pending, sent } = engine();
    const running = Array.from({ length: GRAPH_ENGINE_SLOTS_PER_DB }, (_, i) => execute(ctx(slots), scope(`u${i}`, conn), query).catch(() => undefined));
    await Promise.all(running);
    const refused = await execute(ctx(slots), scope('other', conn), query).catch((e: unknown) => e);
    expect((refused as HttpError).code).toBe('rate_limited');
    expect((refused as HttpError).message).toMatch(/FalkorDB/);
    // Another database is not affected.
    const elsewhere = execute(ctx(slots), scope('other', conn, 'graph-2'), query);
    await sent(GRAPH_ENGINE_SLOTS_PER_DB + 1);
    pending.at(-1)!.answer([['a'], [[1]], []]);
    expect((await elsewhere).reply).toBeDefined();
    expect(GRAPH_ENGINE_SLOTS_PER_DB).toBeLessThan(4); // below the default pool size per (database, tier)
  });

  it('other commands keep the ordinary path: no hold after an answer', async () => {
    const slots = new Slots();
    const { conn, pending, sent } = engine();
    const get = execute(ctx(slots), scope('u1', conn), prepared(['GET', 'k']));
    await sent(1);
    pending[0]!.answer(Buffer.from('v'));
    expect((await get).reply).toBeDefined();
    expect(Number(pending[0]!.opts.timeout)).toBe(40);
  });

  it('never holds every connection of a pool: at most poolSize - 1 graph queries, none on a pool of one (review v0.4 r3 graph L2)', async () => {
    const slots = new Slots();
    const { conn, pending, sent } = engine();
    // poolSize 2: one held query at a time.
    await execute(ctx(slots), scope('a', conn, 'g2', 2), query).catch(() => undefined);
    const second = await execute(ctx(slots), scope('b', conn, 'g2', 2), query).catch((e: unknown) => e);
    expect((second as HttpError).code).toBe('rate_limited');
    // poolSize 1: refused before anything is sent.
    const before = pending.length;
    const one = await execute(ctx(slots), scope('c', conn, 'g1', 1), query).catch((e: unknown) => e);
    expect((one as HttpError).code).toBe('validation');
    expect((one as HttpError).message).toMatch(/poolSize/);
    expect(pending.length).toBe(before);
    await sent(1);
    pending[0]!.answer([[], [], []]);
  });
});

