/**
 * Review v0.3 TOTP L2: a TOTP reset (admin or host CLI) kept the old seed's replay counter, so the newly enrolled
 * authenticator's valid code was refused ("Invalid code.") until the next 30-second step. The counter is now cleared
 * on reset and when a new enrollment starts; replay protection for an unchanged seed is unchanged. Fixed clock.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, runAdmin } from '../../src/cli/admin.ts';
import { totpCode } from '../../src/security/totp.ts';
import { startApp, testConfig, userSession, type TestApp } from '../helpers.ts';
import { createUser, login } from './auth-helpers.ts';

const LIMITS = { loginLimits: { perIpPerSecond: 1000, perIpBurst: 1000 } };
/** 10 s into a 30 s TOTP step, so every code below belongs to one step unless the test moves the clock. */
const T0 = Date.UTC(2026, 9, 24, 12, 0, 10);

describe('TOTP reset clears the replay counter (review v0.3 TOTP L2)', () => {
  const apps: TestApp[] = [];
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }); });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { for (const t of apps) await t.close(); });

  /** Enroll over HTTP at the fixed time; returns the seed. */
  async function enroll(t: TestApp, username: string) {
    const { c, r } = await login(t, username);
    expect(r.status).toBe(200);
    const e = await c.req('POST', '/api/v1/auth/totp/enroll');
    expect(e.status).toBe(200);
    const seed = e.json.secretBase32 as string;
    const confirm = await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(seed) });
    return { seed, confirm };
  }

  for (const via of ['admin', 'cli'] as const) {
    it(`after ${via === 'admin' ? 'an admin' : 'a host CLI'} reset, the new authenticator's code in the same step is accepted; a replay still is not`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'rconsole-l2-'));
      const t = await startApp(testConfig(), { ...LIMITS, ...(via === 'cli' ? { dbPath: dir } : {}) });
      apps.push(t);
      const name = `l2-${via}`;
      await createUser(t, name, 'operator');
      const first = await enroll(t, name);
      expect(first.confirm.status).toBe(200);
      const id = t.ctx.users.byUsername(name)!.id;
      expect(t.ctx.users.byId(id)!.totpLastStep).toBeGreaterThan(0);

      if (via === 'admin') {
        const admin = await userSession(t, 'admin');
        expect((await admin.req('PATCH', `/api/v1/admin/users/${id}`, { resetTotp: true })).status).toBe(200);
      } else {
        expect(runAdmin(['reset-totp', '--user', name, '--data-dir', dir], { env: {}, cwd: dir, out: () => {}, err: () => {} })).toBe(EXIT.ok);
      }
      expect(t.ctx.users.byId(id)!.totpLastStep).toBe(0);

      // Same time step, new seed: before the fix this was 400 "Invalid code.".
      const second = await enroll(t, name);
      expect(second.seed).not.toBe(first.seed);
      expect(second.confirm.status).toBe(200);

      // Replay protection for the unchanged seed: the code just used is refused at sign-in, the next step's is not.
      const { c, r } = await login(t, name);
      expect(r.json).toEqual({ totpRequired: true });
      expect((await c.req('POST', '/api/v1/auth/totp/verify', { code: totpCode(second.seed) })).status).toBe(401);
      vi.setSystemTime(T0 + 30_000);
      expect((await c.req('POST', '/api/v1/auth/totp/verify', { code: totpCode(second.seed) })).status).toBe(200);
    });
  }

  it('starting a new enrollment resets a counter left behind (no reset path cleared it)', async () => {
    const t = await startApp(testConfig(), LIMITS);
    apps.push(t);
    await createUser(t, 'l2-stale', 'viewer');
    const id = t.ctx.users.byUsername('l2-stale')!.id;
    t.ctx.users.update(id, { totpLastStep: Math.floor(T0 / 30_000) + 1 });
    const { seed, confirm } = await enroll(t, 'l2-stale');
    expect(seed).toBeTruthy();
    expect(confirm.status).toBe(200);
  });
});
