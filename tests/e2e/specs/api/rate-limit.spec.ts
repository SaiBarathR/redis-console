/** Availability guards: per-user rate limits (CLI 20/s, scan 10/s), login rate limit. */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { createUser, uniqueName } from '../../lib/accounts.ts';
import { loginBucketExhausted } from '../../lib/throttle.ts';

test.describe('rate limiting', () => {
  let user: Api;
  test.beforeAll(async () => {
    const admin = await Api.fromStorage('admin');
    ({ api: user } = (await createUser(admin, uniqueName('rl'), 'operator')) as { api: Api });
    await admin.dispose();
  });
  test.afterAll(async () => { await user.dispose(); });

  test('CLI: a burst of 80 requests is throttled with 429 rate_limited, then recovers', async () => {
    const rs = await Promise.all(Array.from({ length: 80 }, () => user.post(dbPath(DB.e2e, 'cli'), { line: 'PING' }, { noRetry: true })));
    const codes = rs.map((r) => r.status);
    const limited = rs.filter((r) => r.status === 429);
    expect(limited.length, `statuses: ${JSON.stringify(codes)}`).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    expect(limited[0]!.json.error.code).toBe('rate_limited');
    expect(codes.every((c) => c === 200 || c === 429)).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await user.post(dbPath(DB.e2e, 'cli'), { line: 'PING' })).status).toBe(200);
  });

  test('scan: a burst of 40 is throttled', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const rs = await Promise.all(Array.from({ length: 40 }, () => user.post(dbPath(DB.e2e, 'keys/scan'), { count: 10 }, { noRetry: true })));
    expect(rs.some((r) => r.status === 429)).toBe(true);
  });

  test('rate limits are per user: another user is unaffected', async () => {
    const viewer = await Api.fromStorage('viewer');
    await Promise.all(Array.from({ length: 60 }, () => user.post(dbPath(DB.e2e, 'cli'), { line: 'PING' }, { noRetry: true })));
    expect((await viewer.post(dbPath(DB.e2e, 'cli'), { line: 'PING' })).status).toBe(200);
    await viewer.dispose();
  });

  test('login attempts are rate limited globally', async () => {
    const anon = await Api.anonymous();
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => anon.post(`${API}/auth/login`, { username: `nobody-${i}`, password: 'wrong-password-x' }, { csrf: null, noThrottle: true, noRetry: true })));
    loginBucketExhausted();
    const codes = rs.map((r) => r.status);
    expect(codes.some((c) => c === 429), JSON.stringify(codes)).toBe(true);
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    await anon.dispose();
  });
});
