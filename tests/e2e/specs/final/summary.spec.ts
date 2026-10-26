/**
 * Runs last. Aggregate security assertions over the whole run:
 *  - no secret leaked in any JSON/SSE/HTML response collected by the API client and pages
 *  - the server log (stdout/stderr, incl. audit JSON lines) contains no secrets and no Redis values
 *  - only read commands reached the selected remote upstream (via the read-only proxy)
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { LEAK_COUNT_FILE, LEAK_FINDINGS_FILE, scanForLeaks } from '../../lib/leak.ts';
import { PROXY_SEEN_FILE, PROXY_VIOLATIONS_FILE } from '../../lib/readonly-proxy.ts';
import { SERVER_LOG } from '../../lib/server.ts';
import { AUDIT_CANARY_VALUE, XSS_PAYLOADS } from '../../lib/fixtures-data.ts';

const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

test('secret leak scan: no finding across every collected response', () => {
  const scanned = lines(LEAK_COUNT_FILE).map((l) => JSON.parse(l));
  test.info().annotations.push({ type: 'responses scanned', description: String(scanned.length) });
  expect(scanned.length, 'responses scanned during the run').toBeGreaterThan(200);
  expect(scanned.some((s) => s.source.startsWith('SSE')), 'SSE streams were scanned').toBe(true);
  expect(lines(LEAK_FINDINGS_FILE).map((l) => JSON.parse(l))).toEqual([]);
});

test('server log contains no secrets, no session ids and no Redis values', () => {
  const log = existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8') : '';
  test.skip(process.env.RC_E2E_EXTERNAL_SERVER === '1', 'server log not captured for external servers');
  expect(log.length).toBeGreaterThan(0);
  expect(scanForLeaks(log, 'server.log').filter((f) => f.kind !== 'redis-connection-url')).toEqual([]);
  expect(log).not.toContain(AUDIT_CANARY_VALUE);
  expect(log).not.toContain('Hello from Redis Console e2e');
  for (const p of XSS_PAYLOADS) expect(log).not.toContain(p);
  expect(log).not.toMatch(/rc_session=[A-Za-z0-9_-]{20,}/);
  expect(log).not.toMatch(/"x-csrf-token"\s*:\s*"[A-Za-z0-9_-]{20,}"/i);
  expect(log, 'connection URLs with credentials').not.toMatch(/rediss?:\/\/[^\s"]*:[^\s"@]+@/);
});

test('server emits audit JSON lines for SIEM', () => {
  test.skip(process.env.RC_E2E_EXTERNAL_SERVER === '1', 'server log not captured for external servers');
  const audit = lines(SERVER_LOG).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.audit === true);
  expect(audit.length).toBeGreaterThan(10);
  for (const a of audit) expect(JSON.stringify(a)).not.toContain(AUDIT_CANARY_VALUE);
});

test('only read commands ever reached the selected remote upstream', () => {
  const violations = lines(PROXY_VIOLATIONS_FILE);
  const seen = existsSync(PROXY_SEEN_FILE) ? JSON.parse(readFileSync(PROXY_SEEN_FILE, 'utf8')) : {};
  test.info().annotations.push({ type: 'commands forwarded to upstream', description: JSON.stringify(seen) });
  expect(Object.keys(seen).length, 'the server did talk to remote-6390 through the proxy').toBeGreaterThan(0);
  expect(violations, 'non-read commands blocked by the proxy (each one is a server bug)').toEqual([]);
});
