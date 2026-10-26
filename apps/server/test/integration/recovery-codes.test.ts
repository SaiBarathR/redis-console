/**
 * TOTP recovery codes: issued once at enrollment, hashed at rest, single use (also under concurrent use), accepted
 * in place of a TOTP code (TOTP step or one-step login), regenerated with re-authentication (old set revoked),
 * subject to lockout and rate limits, audited as auth.recovery without the codes, cleared by an admin TOTP reset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECOVERY_CODE_COUNT } from '@rconsole/shared';
import { totpCode } from '../../src/security/totp.ts';
import { anonymous, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';
import { createUser, login, PASSWORD } from './auth-helpers.ts';

const BIG_LIMITS = { loginLimits: { perIpPerSecond: 1000, perIpBurst: 1000 } };
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/;

/** Sign in, enroll TOTP over HTTP; returns the client, the seed and the recovery codes shown at confirmation. */
async function enrolled(t: TestApp, username: string, role: 'viewer' | 'operator' | 'admin' = 'operator') {
  await createUser(t, username, role);
  const { c } = await login(t, username);
  const e = await c.req('POST', '/api/v1/auth/totp/enroll');
  expect(e.status).toBe(200);
  const seed = e.json.secretBase32 as string;
  const r = await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(seed) });
  expect(r.status).toBe(200);
  return { c, seed, codes: r.json.recoveryCodes as string[], confirm: r };
}

/** Password step only: a client holding a TOTP-pending session. */
async function pending(t: TestApp, username: string): Promise<Client> {
  const { c, r } = await login(t, username);
  expect(r.json).toEqual({ totpRequired: true });
  return c;
}

const auditEvents = (t: TestApp) => t.auditLines.map((l) => JSON.parse(l));

describe('recovery codes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { lockout: { maxAttempts: 3, windowMinutes: 1 } } }), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  it('enrollment returns 10 human-friendly codes once, stores only argon2id hashes, and me counts them', async () => {
    const { c, codes, confirm } = await enrolled(t, 'rc-enroll');
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(CODE_RE);
    expect(confirm.json.me.recoveryCodesRemaining).toBe(10);
    const me = await c.req('GET', '/api/v1/auth/me');
    expect(me.json.recoveryCodesRemaining).toBe(10);
    expect(me.body).not.toContain(codes[0]);
    const rows = t.ctx.db.prepare('SELECT code_hash, salt FROM recovery_codes WHERE user_id = ?').all(t.ctx.users.byUsername('rc-enroll')!.id) as { code_hash: string; salt: string }[];
    expect(rows).toHaveLength(10);
    const dump = JSON.stringify(rows);
    for (const code of codes) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replaceAll('-', ''));
    }
    expect(rows.every((r) => r.code_hash.startsWith('a2id:m=19456,t=2,p=1$'))).toBe(true);
    expect(new Set(rows.map((r) => r.salt)).size).toBe(1);
  });

  it('accounts without TOTP and OIDC sessions have no recoveryCodesRemaining', async () => {
    const c = await userSession(t, 'viewer');
    expect((await c.req('GET', '/api/v1/auth/me')).json).not.toHaveProperty('recoveryCodesRemaining');
  });

  it('a recovery code completes the TOTP step once; reuse is refused', async () => {
    const { codes } = await enrolled(t, 'rc-once');
    const p = await pending(t, 'rc-once');
    // Case, spaces and hyphens do not matter.
    const r = await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: ` ${codes[0]!.toUpperCase().replaceAll('-', ' ')} ` });
    expect(r.status).toBe(200);
    expect(r.json.me).toMatchObject({ username: 'rc-once', recoveryCodesRemaining: 9 });
    expect((await p.req('GET', '/api/v1/auth/me')).status).toBe(200);

    const again = await pending(t, 'rc-once');
    const replay = await again.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: codes[0] });
    expect(replay.status).toBe(401);
    expect(replay.json.error.message).toBe('Invalid code.');
    expect((await again.req('GET', '/api/v1/auth/me')).status).toBe(401);
    t.ctx.users.resetFailures(t.ctx.users.byUsername('rc-once')!.id);
  });

  it('a code used concurrently from two sign-ins succeeds exactly once', async () => {
    const { codes } = await enrolled(t, 'rc-race');
    const id = t.ctx.users.byUsername('rc-race')!.id;
    for (let round = 0; round < 3; round++) {
      const a = await pending(t, 'rc-race');
      const b = await pending(t, 'rc-race');
      const c = await pending(t, 'rc-race');
      const code = codes[round]!;
      const results = await Promise.all([a, b, c].map((x) => x.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: code })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
      t.ctx.users.resetFailures(id);
    }
    expect(t.ctx.users.recoveryCodesRemaining(id)).toBe(7);
  });

  it('one-step login: password + recoveryCode signs in; a wrong code gets the generic error', async () => {
    const { codes } = await enrolled(t, 'rc-onestep');
    const bad = await anonymous(t).req('POST', '/api/v1/auth/login', { username: 'rc-onestep', password: PASSWORD, recoveryCode: 'aaaa-bbbb-cccc' });
    expect(bad.status).toBe(401);
    expect(bad.json.error.message).toBe('Invalid username or password, or the account is temporarily locked.');
    const c = anonymous(t);
    const ok = await c.req('POST', '/api/v1/auth/login', { username: 'rc-onestep', password: PASSWORD, recoveryCode: codes[1] });
    expect(ok.status).toBe(200);
    expect(ok.json.me).toMatchObject({ username: 'rc-onestep', recoveryCodesRemaining: 9 });
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);
    // A wrong password with a valid code does not consume it.
    const wrongPw = await anonymous(t).req('POST', '/api/v1/auth/login', { username: 'rc-onestep', password: 'wrong password!!', recoveryCode: codes[2] });
    expect(wrongPw.status).toBe(401);
    expect(t.ctx.users.recoveryCodesRemaining(t.ctx.users.byUsername('rc-onestep')!.id)).toBe(9);
    t.ctx.users.resetFailures(t.ctx.users.byUsername('rc-onestep')!.id);
  });

  it('regenerate needs the password, returns a new set once, and revokes the old one', async () => {
    const { c, codes } = await enrolled(t, 'rc-regen');
    const id = t.ctx.users.byUsername('rc-regen')!.id;
    const wrong = await c.req('POST', '/api/v1/auth/recovery-codes', { currentPassword: 'wrong password!!' });
    expect(wrong.status).toBe(403);
    expect(t.ctx.users.recoveryCodesRemaining(id)).toBe(10);
    t.ctx.users.resetFailures(id);
    const r = await c.req('POST', '/api/v1/auth/recovery-codes', { currentPassword: PASSWORD });
    expect(r.status).toBe(200);
    const fresh = r.json.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((x) => codes.includes(x))).toBe(false);
    expect(r.json.me.recoveryCodesRemaining).toBe(10);
    // The session making the change stays signed in.
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);

    const old = await pending(t, 'rc-regen');
    expect((await old.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: codes[3] })).status).toBe(401);
    const neu = await pending(t, 'rc-regen');
    expect((await neu.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: fresh[3] })).status).toBe(200);
    t.ctx.users.resetFailures(id);
  });

  it('regenerate is refused without TOTP, and for a TOTP-pending session', async () => {
    const plain = await userSession(t, 'operator');
    const r = await plain.req('POST', '/api/v1/auth/recovery-codes', { currentPassword: PASSWORD });
    expect(r.status).toBe(400);
    await enrolled(t, 'rc-pendregen');
    const p = await pending(t, 'rc-pendregen');
    expect((await p.req('POST', '/api/v1/auth/recovery-codes', { currentPassword: PASSWORD })).status).toBe(401);
  });

  it('failed recovery codes count toward the lockout; a locked account refuses a valid code and a valid TOTP', async () => {
    const { codes } = await enrolled(t, 'rc-lock');
    const id = t.ctx.users.byUsername('rc-lock')!.id;
    const p = await pending(t, 'rc-lock');
    expect((await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: 'zzzz-zzzz-zzzz' })).status).toBe(401);
    expect((await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: 'yyyy-yyyy-yyyy' })).status).toBe(401);
    expect((await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: 'xxxx-xxxx-xxxx' })).status).toBe(401);
    expect(t.ctx.users.isLockedNow(id)).toBe(true);
    // The lock ended the pending session; a new password sign-in is refused while locked.
    expect((await login(t, 'rc-lock')).r.status).toBe(401);
    const viaLogin = await anonymous(t).req('POST', '/api/v1/auth/login', { username: 'rc-lock', password: PASSWORD, recoveryCode: codes[0] });
    expect(viaLogin.status).toBe(401);
    expect(t.ctx.users.recoveryCodesRemaining(id)).toBe(10);
    t.ctx.users.resetFailures(id);
    const ok = await pending(t, 'rc-lock');
    expect((await ok.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: codes[0] })).status).toBe(200);
  });

  it('every use is audited as auth.recovery, and neither the audit nor the log carries a code', async () => {
    const before = t.auditLines.length;
    const { codes } = await enrolled(t, 'rc-audit');
    const p = await pending(t, 'rc-audit');
    await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: 'wwww-wwww-wwww' });
    await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: codes[4] });
    const evs = auditEvents(t).filter((e) => e.username === 'rc-audit');
    const rec = evs.filter((e) => e.action === 'auth.recovery');
    expect(rec.map((e) => e.outcome)).toEqual(['denied', 'allowed']);
    expect(rec[1].detail).toBe('TOTP step with a recovery code; 9 left');
    expect(evs.find((e) => e.action === 'auth.totp.confirm' && e.outcome === 'allowed')?.detail).toBe('10 recovery codes issued');
    const all = t.auditLines.slice(before).join('\n') + JSON.stringify(t.ctx.audit.query({ user: 'rc-audit', limit: 100 }));
    for (const code of [...codes, 'wwww-wwww-wwww']) {
      expect(all).not.toContain(code);
      expect(all).not.toContain(code.replaceAll('-', ''));
    }
    t.ctx.users.resetFailures(t.ctx.users.byUsername('rc-audit')!.id);
  });

  it('an admin TOTP reset clears the recovery codes', async () => {
    await enrolled(t, 'rc-reset');
    const id = t.ctx.users.byUsername('rc-reset')!.id;
    const admin = await userSession(t, 'admin');
    const r = await admin.req('PATCH', `/api/v1/admin/users/${encodeURIComponent(id)}`, { resetTotp: true });
    expect(r.status).toBe(200);
    expect(r.json.totpEnabled).toBe(false);
    expect((t.ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?').get(id) as { n: number }).n).toBe(0);
    // Without TOTP, the password alone signs in, and a recovery code is meaningless.
    const { r: l } = await login(t, 'rc-reset');
    expect(l.json.me.totpEnabled).toBe(false);
    expect(l.json.me).not.toHaveProperty('recoveryCodesRemaining');
  });

  it('an admin TOTP reset racing an enrollment confirmation never leaves TOTP or recovery codes behind', async () => {
    await createUser(t, 'rc-confirm-race', 'operator');
    const id = t.ctx.users.byUsername('rc-confirm-race')!.id;
    const { c } = await login(t, 'rc-confirm-race');
    const seed = (await c.req('POST', '/api/v1/auth/totp/enroll')).json.secretBase32 as string;
    const admin = await userSession(t, 'admin');
    // The confirmation hashes ten codes (argon2id) before writing; the reset lands meanwhile.
    const confirm = c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(seed) });
    await new Promise((r) => setTimeout(r, 20));
    const reset = await admin.req('PATCH', `/api/v1/admin/users/${encodeURIComponent(id)}`, { resetTotp: true });
    expect(reset.status).toBe(200);
    expect((await confirm).status).toBe(401);
    expect(t.ctx.users.byId(id)!.totpSecret).toBeNull();
    expect(t.ctx.users.recoveryCodesRemaining(id)).toBe(0);
  });

  it('a recovery sign-in racing an admin TOTP reset does not sign in', async () => {
    const { codes } = await enrolled(t, 'rc-signin-race');
    const id = t.ctx.users.byUsername('rc-signin-race')!.id;
    const admin = await userSession(t, 'admin');
    const p = await pending(t, 'rc-signin-race');
    const store = t.ctx.users as unknown as { recoveryCodeSalt: (id: string) => string | null };
    const orig = store.recoveryCodeSalt.bind(t.ctx.users);
    let reset: Promise<{ status: number }> | undefined;
    store.recoveryCodeSalt = (uid: string) => {
      store.recoveryCodeSalt = orig;
      reset = admin.req('PATCH', `/api/v1/admin/users/${encodeURIComponent(id)}`, { resetTotp: true });
      return orig(uid);
    };
    const r = await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: codes[0] });
    expect((await reset!).status).toBe(200);
    expect(r.status).toBe(401);
    expect((await p.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('validates the recovery code shape and rejects mixing code and recoveryCode', async () => {
    await enrolled(t, 'rc-shape');
    const p = await pending(t, 'rc-shape');
    expect((await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: '<script>alert(1)</script>' })).status).toBe(400);
    expect((await p.req('POST', '/api/v1/auth/totp/verify', { code: '123456', recoveryCode: 'aaaa-bbbb-cccc' })).status).toBe(400);
  });
});

describe('recovery codes: sign-in rate limit', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { lockout: { maxAttempts: 50, windowMinutes: 1 } } }), { loginLimits: { perIpPerSecond: 0.001, perIpBurst: 6 } });
  });
  afterAll(async () => t?.close());

  it('recovery attempts share the per-IP sign-in limit (429)', async () => {
    const { c } = await login(t, (await createUser(t, 'rc-rate', 'operator')).username); // 1
    const e = await c.req('POST', '/api/v1/auth/totp/enroll');
    await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(e.json.secretBase32) }); // 2
    const p = await pending(t, 'rc-rate'); // 3
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await p.req('POST', '/api/v1/auth/totp/verify', { recoveryCode: 'aaaa-aaaa-aaaa' })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
