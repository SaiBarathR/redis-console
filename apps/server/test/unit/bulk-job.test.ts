import { ErrorReply } from 'redis';
import { describe, expect, it } from 'vitest';
import { inSlotOrder, runJob, type Job } from '../../src/routes/bulkDelete.ts';
import { HttpError } from '../../src/http/errors.ts';
import type { Arg, Conn, Target } from '../../src/redis/manager.ts';

/** A keyspace of `size` keys; UNLINK answers with `unlink`. */
function fake(size: number, unlink: (keys: Arg[]) => unknown): Pick<Conn, 'send' | 'mode' | 'primaries'> {
  const node: Target = {
    label: 'fake',
    send: async <T,>(args: Arg[]) => {
      if (args[0] === 'SCAN') {
        const cursor = Number(args[1]);
        const end = Math.min(size, cursor + Number(args[args.indexOf('COUNT') + 1]));
        return [String(end >= size ? 0 : end), Array.from({ length: end - cursor }, (_, i) => Buffer.from(`k${cursor + i}`))] as T;
      }
      const r = await unlink(args.slice(1));
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { ...node, mode: 'standalone', primaries: async () => [node] };
}
const job = (): Job => ({
  view: { id: 'j', state: 'running', scanned: 0, deleted: 0, failed: 0, errors: [], complete: false, startedAt: '', elapsedMs: 0 },
  userId: 'u', sessionHash: 's', databaseId: 'd', started: Date.now(), cancel: false, done: Promise.resolve(), errors: new Map(),
});
const body = { match: 'k*' };

describe('bulk delete job runner (F20)', () => {
  it('counts deleted keys and finishes complete', async () => {
    const j = job();
    await runJob(j, fake(4500, (keys) => keys.length), body, () => true, 1 << 20);
    expect(j.view).toMatchObject({ state: 'done', deleted: 4500, failed: 0, scanned: 4500, complete: true });
  });
  it('cluster mode: per-key deletes on concurrent workers are all counted', async () => {
    const j = job();
    const conn = fake(3000, () => new Promise((r) => setTimeout(() => r(1), Math.random() * 3)));
    await runJob(j, { ...conn, mode: 'cluster' }, body, () => true, 1 << 20);
    expect(j.view).toMatchObject({ state: 'done', deleted: 3000, failed: 0 });
  });
  it('counts failures by error code only, and gives up after three failed batches in a row', async () => {
    const j = job();
    let calls = 0;
    await runJob(j, fake(20_000, () => (++calls === 1 ? 500 : new ErrorReply('NOPERM this user has no permissions to run the unlink command with secret-key'))), body, () => true, 1 << 20);
    expect(j.view).toMatchObject({ state: 'failed', stopReason: 'errors', deleted: 500 });
    expect([...j.errors]).toEqual([['NOPERM', j.view.failed]]);
    expect(JSON.stringify([...j.errors])).not.toContain('secret-key');
  });
  it('keeps going after an isolated failure and bounds distinct codes', async () => {
    const j = job();
    let calls = 0;
    await runJob(j, fake(12_000, (keys) => (++calls % 2 ? new ErrorReply(`E${calls} boom`) : keys.length)), body, () => true, 1 << 20);
    expect(j.view.state).toBe('done');
    expect(j.view.deleted + j.view.failed).toBe(12_000);
    expect(j.errors.size).toBeLessThanOrEqual(9);
  });
  it('stops on cancel, on a revoked actor, and on a refused command', async () => {
    const cancelled = job();
    cancelled.cancel = true;
    await runJob(cancelled, fake(10, (keys) => keys.length), body, () => true, 1 << 20);
    expect(cancelled.view).toMatchObject({ state: 'cancelled', stopReason: 'cancelled', deleted: 0 });
    const revoked = job();
    await runJob(revoked, fake(10, (keys) => keys.length), body, () => false, 1 << 20);
    expect(revoked.view).toMatchObject({ state: 'stopped', stopReason: 'session' });
    const shutdown = job();
    await runJob(shutdown, fake(10, (keys) => keys.length), body, () => true, 1 << 20, () => true);
    expect(shutdown.view).toMatchObject({ state: 'stopped', stopReason: 'shutdown', deleted: 0, failed: 0 });
    const refused = job();
    await runJob(refused, fake(10, () => new HttpError('unauthenticated', 'revoked')), body, () => true, 1 << 20);
    expect(refused.view).toMatchObject({ state: 'stopped', stopReason: 'session', failed: 0 });
  });
});

describe('cluster per-key commands after a failure (review v0.2.1 F5)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('inSlotOrder rethrows the first failure only after the commands already sent have settled', async () => {
    let settled = 0;
    let calls = 0;
    const run = inSlotOrder(['a', 'b', 'c', 'd', 'e'], (k) => k, async () => {
      if (++calls === 1) throw new HttpError('unauthenticated', 'revoked');
      await sleep(20);
      settled++;
    });
    await expect(run).rejects.toMatchObject({ code: 'unauthenticated' });
    // The other three workers had already sent their command; no fifth one was started after the failure.
    expect(settled).toBe(3);
    expect(calls).toBe(4);
  });

  it('a job stopped by a revocation reports, and audits, every UNLINK that completed', async () => {
    const j = job();
    let calls = 0;
    const conn = fake(100, async () => {
      if (++calls === 1) return new HttpError('unauthenticated', 'revoked');
      await sleep(20);
      return 1;
    });
    await runJob(j, { ...conn, mode: 'cluster' }, body, () => true, 1 << 20);
    const reported = j.view.deleted;
    await sleep(60);
    expect(j.view).toMatchObject({ state: 'stopped', stopReason: 'session' });
    // The final audit reads `deleted` when runJob returns: it must already include the in-flight deletes.
    expect(reported).toBe(3);
    expect(j.view.deleted).toBe(reported);
  });
});
