import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@rconsole/shared';
import { startApp, testConfig, type TestApp } from '../helpers.ts';

describe('contract: every ROUTES entry is served', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig());
  });
  afterAll(() => t.close());

  for (const [name, spec] of Object.entries(ROUTES)) {
    it(`${name}: ${spec}`, () => {
      const [method, url] = spec.split(' ') as [string, string];
      expect(t.app.hasRoute({ method: method as 'GET', url })).toBe(true);
    });
  }

  it('no unauthenticated API route besides the public auth/health ones', async () => {
    const publicOk = new Set([ROUTES.health, ROUTES.ready, ROUTES.providers, ROUTES.login, ROUTES.oidcStart, ROUTES.oidcCallback, ROUTES.totpVerify]);
    for (const spec of Object.values(ROUTES)) {
      if (publicOk.has(spec as never)) continue;
      const [method, url] = spec.split(' ') as [string, string];
      const r = await t.app.inject({
        method: method as 'GET',
        url: url.replace(':db', 'e2e').replace(':id', 'x'),
        headers: { origin: 'http://localhost:4100', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { payload: '{}' }),
      });
      expect(r.statusCode, spec).toBe(401);
    }
  });
});
