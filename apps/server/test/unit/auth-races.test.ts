/**
 * Review H1: authentication that is in flight (waiting on argon2) while an admin changes the account must not
 * produce a session with the old role, skip newly enabled TOTP, or bring back a revoked session.
 *
 * The admin request is started from inside the user-record read that precedes the password hash, so it runs
 * while the real argon2 verification is pending; `adminDone` proves it finished before the auth flow resumed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anonymous, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';
import { createUser, login, PASSWORD } from '../integration/auth-helpers.ts';
import { totpCode } from '../../src/security/totp.ts';

describe('auth races (H1)', () => {
  let t: TestApp;
  let admin: Client;
  beforeEach(async () => {
    t = await startApp(testConfig());
    admin = await userSession(t, 'admin', 'raceadmin');
  });
  afterEach(() => t.close());

  /** Run `during` (an HTTP request) the next time `method` reads `userId`'s record; resolves when it finished. */
  function duringRead(method: 'byUsername' | 'byId', match: (u: { id: string; username: string } | null) => boolean, during: () => Promise<unknown>) {
    const store = t.ctx.users as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = store[method]!.bind(t.ctx.users);
    let fired = false;
    let done = false;
    let p: Promise<unknown> = Promise.resolve();
    store[method] = (...a: unknown[]) => {
      const u = orig(...a) as { id: string; username: string } | null;
      if (!fired && match(u)) {
        fired = true;
        store[method] = orig;
        p = during().then((r) => {
          done = true;
          return r;
        });
      }
      return u;
    };
    // The auth flow re-checks the lock right after hashing: by then the admin request must have finished.
    const lockOrig = t.ctx.users.isLockedNow.bind(t.ctx.users);
    t.ctx.users.isLockedNow = (id: string) => {
      if (fired) expect(done, 'admin change finished while the hash was pending').toBe(true);
      return lockOrig(id);
    };
    return { wait: () => p, fired: () => fired };
  }

  const liveSessions = (userId: string) => t.ctx.db.prepare('SELECT role, state FROM sessions WHERE user_id = ?').all(userId) as { role: string; state: string }[];

  it('a login racing a demotion never yields a session with the old role', async () => {
    const u = await createUser(t, 'racer', 'operator');
    const race = duringRead('byUsername', (x) => x?.id === u.id, () => admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { role: 'viewer' }));
    const { c, r } = await login(t, 'racer');
    expect((await race.wait()) as { status: number }).toMatchObject({ status: 200 });
    expect(race.fired()).toBe(true);
    expect(r.json?.me?.role).not.toBe('operator');
    expect(liveSessions(u.id).filter((s) => s.role === 'operator')).toEqual([]);
    const me = await c.req('GET', '/api/v1/auth/me');
    if (me.status === 200) expect(me.json.role).toBe('viewer');
    else expect(me.status).toBe(401);
  });

  it('a password-only login racing TOTP activation does not get an active session', async () => {
    const u = await createUser(t, 'totprace', 'operator');
    const { c: owner } = await login(t, 'totprace');
    const enroll = await owner.req('POST', '/api/v1/auth/totp/enroll', {});
    expect(enroll.status).toBe(200);
    const race = duringRead('byUsername', (x) => x?.id === u.id, () => owner.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(enroll.json.secretBase32) }));
    const attacker = anonymous(t);
    const { r } = await login(t, 'totprace', PASSWORD, attacker);
    expect((await race.wait()) as { status: number }).toMatchObject({ status: 200 });
    expect(r.json?.me).toBeUndefined();
    const me = await attacker.req('GET', '/api/v1/auth/me');
    expect(me.status).toBe(401);
  });

  it('a password change racing a demotion fails and does not resurrect the revoked session', async () => {
    const u = await createUser(t, 'pwrace', 'operator');
    const { c } = await login(t, 'pwrace');
    expect(liveSessions(u.id).length).toBe(1);
    // The request gate reads the user (byId) before the handler hashes; demote right then.
    const race = duringRead('byId', (x) => x?.id === u.id, () => admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { role: 'viewer' }));
    const r = await c.req('POST', '/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase 42' });
    expect((await race.wait()) as { status: number }).toMatchObject({ status: 200 });
    expect(r.status).toBe(401);
    expect(r.json?.me).toBeUndefined();
    expect(liveSessions(u.id)).toEqual([]);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('a session whose user changed role behind its back is refused (generation check at the gate)', async () => {
    const u = await createUser(t, 'stale', 'operator');
    const { c } = await login(t, 'stale');
    t.ctx.users.update(u.id, { role: 'viewer' }); // e.g. a write that did not revoke sessions
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('rotation refuses a session that was already revoked', () => {
    const { session } = t.ctx.sessions.create({ userId: 'x', username: 'x', displayName: 'x', source: 'local', role: 'viewer', state: 'active', ip: '127.0.0.1' });
    t.ctx.sessions.destroyUser('x');
    expect(() => t.ctx.sessions.rotate(session)).toThrow();
    expect(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('x')).toEqual({ n: 0 });
  });

  it('an admin resetting their own password keeps their session', async () => {
    const me = t.ctx.users.byUsername('raceadmin')!;
    const r = await admin.req('PATCH', `/api/v1/admin/users/${me.id}`, { newPassword: 'another long passphrase 7' });
    expect(r.status).toBe(200);
    expect((await admin.req('GET', '/api/v1/auth/me')).status).toBe(200);
  });
});
