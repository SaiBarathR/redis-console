/**
 * Secret leak scanner. Every JSON / SSE / HTML response collected by the API
 * client and the page fixture is checked for:
 *  - any value from .env (sandbox passwords, OIDC client secret, session secret, ...)
 *  - redis:// or rediss:// URLs that carry credentials
 *  - extra secrets registered at runtime (passwords of users created by the tests)
 * Findings are appended to .state/leak-findings.jsonl and fail the current test.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR, secretValues } from './env.ts';

export const LEAK_FINDINGS_FILE = path.join(STATE_DIR, 'leak-findings.jsonl');
export const LEAK_COUNT_FILE = path.join(STATE_DIR, 'leak-scanned.jsonl');
const EXTRA_SECRETS_FILE = path.join(STATE_DIR, 'extra-secrets.json');

const CRED_URL = /rediss?:\/\/[^\s"'<>/@]*:[^\s"'<>/@]+@/i;
const ANY_REDIS_URL = /rediss?:\/\/[^\s"'<>]+/i;

export function registerExtraSecret(name: string, value: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  let cur: Record<string, string> = {};
  try { cur = JSON.parse(readFileSync(EXTRA_SECRETS_FILE, 'utf8')); } catch { /* none yet */ }
  cur[name] = value;
  writeFileSync(EXTRA_SECRETS_FILE, JSON.stringify(cur));
}

function extraSecrets(): { name: string; value: string }[] {
  if (!existsSync(EXTRA_SECRETS_FILE)) return [];
  try {
    const m = JSON.parse(readFileSync(EXTRA_SECRETS_FILE, 'utf8')) as Record<string, string>;
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export interface LeakFinding { source: string; kind: string; secretName?: string }

/** A redis:// URL without credentials is reported too: connection URLs must never reach the browser. */
export function scanForLeaks(text: string, source: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const s of [...secretValues(), ...extraSecrets()]) {
    if (text.includes(s.value)) findings.push({ source, kind: 'secret-value', secretName: s.name });
  }
  if (CRED_URL.test(text)) findings.push({ source, kind: 'redis-url-with-credentials' });
  else if (ANY_REDIS_URL.test(text)) findings.push({ source, kind: 'redis-connection-url' });
  return findings;
}

/** Scans and records; returns findings (callers assert they are empty). */
export function recordScan(text: string, source: string): LeakFinding[] {
  mkdirSync(STATE_DIR, { recursive: true });
  const f = scanForLeaks(text, source);
  appendFileSync(LEAK_COUNT_FILE, JSON.stringify({ source, bytes: text.length, findings: f.length }) + '\n');
  for (const x of f) appendFileSync(LEAK_FINDINGS_FILE, JSON.stringify(x) + '\n');
  return f;
}
