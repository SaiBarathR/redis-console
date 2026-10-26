/**
 * Review v0.2 M5: an administrative change waits for argon2 before it writes. An admin who is disabled (or signed
 * out) while that hash is pending must not complete the change, and a change must not overwrite one that another
 * admin made to the same account meanwhile.
 *
 * hashPassword is gated so the other admin's request deterministically runs while the hash is pending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';
import { verifyPassword } from '../../src/security/password.ts';

const gate: { wait?: Promise<void>; started?: () => void } = {};
vi.mock('../../src/security/password.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/security/password.ts')>();
  return {
    ...orig,
    hashPassword: async (p: string) => {
      const h = await orig.hashPassword(p);
      // Only the first hash after `race` armed the gate waits.
      const wait = gate.wait;
      gate.wait = undefined;
      if (wait) {
        gate.started?.();
        await wait;
      }
      return h;
    },
  };
});

describe('admin changes racing a revocation (review v0.2 M5)', () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  beforeEach(async () => {
    t = await startApp(testConfig());
    a = await userSession(t, 'admin', 'race-admin-a');
    b = await userSession(t, 'admin', 'race-admin-b');
  });
  afterEach(() => t.close());

  /** Start `first`; once its password hash is pending, run `during` to completion, then let the hash finish. */
  async function race<T>(first: () => Promise<T>, during: () => Promise<{ status: number }>): Promise<T> {
    let release!: () => void;
    const hashing = new Promise<void>((r) => (gate.started = r));
    gate.wait = new Promise<void>((r) => (release = r));
    const p = first();
    await hashing;
    expect((await during()).status).toBe(200);
    release();
    return p;
  }

  it('a create whose admin was disabled while the password hash was pending is refused and audited', async () => {
    const r = await race(
      () => a.req('POST', '/api/v1/admin/users', { username: 'late-admin', displayName: 'Late', role: 'admin', initialPassword: 'a long enough password' }),
      () => b.req('PATCH', `/api/v1/admin/users/${a.userId}`, { disabled: true }),
    );
    expect(r.status).toBe(401);
    expect(t.ctx.users.byUsername('late-admin')).toBeNull();
    const ev = t.ctx.audit.query({ action: 'admin.user.create', limit: 1 }).events[0]!;
    expect(ev).toMatchObject({ outcome: 'denied', username: 'race-admin-a' });
  });

  it('a password reset whose admin was disabled meanwhile changes nothing', async () => {
    const target = await userSession(t, 'operator', 'race-target');
    const before = t.ctx.users.byId(target.userId)!;
    const r = await race(
      () => a.req('PATCH', `/api/v1/admin/users/${target.userId}`, { displayName: 'Renamed', newPassword: 'another long password' }),
      () => b.req('PATCH', `/api/v1/admin/users/${a.userId}`, { disabled: true }),
    );
    expect(r.status).toBe(401);
    const after = t.ctx.users.byId(target.userId)!;
    expect(after.displayName).toBe(before.displayName);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.authGen).toBe(before.authGen);
  });

  it("a password reset does not overwrite another admin's concurrent change to the same account", async () => {
    const target = await userSession(t, 'operator', 'race-target2');
    const r = await race(
      () => a.req('PATCH', `/api/v1/admin/users/${target.userId}`, { newPassword: 'password from admin a' }),
      () => b.req('PATCH', `/api/v1/admin/users/${target.userId}`, { newPassword: 'password from admin b' }),
    );
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/changed/);
    expect(await verifyPassword('password from admin b', t.ctx.users.byId(target.userId)!.passwordHash!)).toBe(true);
  });

  it('without a race both still work', async () => {
    const c = await a.req('POST', '/api/v1/admin/users', { username: 'calm-user', displayName: 'Calm', role: 'viewer', initialPassword: 'a long enough password' });
    expect(c.status).toBe(201);
    const p = await a.req('PATCH', `/api/v1/admin/users/${c.json.id}`, { displayName: 'Calmer', newPassword: 'another long password' });
    expect(p.status).toBe(200);
    expect(p.json.displayName).toBe('Calmer');
  });
});
