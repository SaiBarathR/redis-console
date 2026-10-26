import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.ts';
import { CONFIRM_TTL_MS, Confirmations, MAX_PENDING_PER_SESSION, canonical, requestHash } from '../../src/policy/confirm.ts';
import type { ConfirmSpec } from '../../src/policy/policy.ts';

const S1 = 'session-hash-1';
const S2 = 'session-hash-2';
const H = requestHash('cli', 'db1', { line: 'DEL k' });
const confirmSpec: ConfirmSpec = { level: 'confirm', reasonRequired: false, summary: 'DEL on DB', preview: { total: 1, commands: [] } };
const typedSpec: ConfirmSpec = { level: 'typed', expectedText: 'Prod DB', reasonRequired: true, summary: 'SET on Prod DB', preview: { total: 1, commands: [] } };

function setup() {
  let now = 1_000_000;
  const c = new Confirmations(() => now);
  return { c, advance: (ms: number) => (now += ms) };
}

function challenge(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    const he = e as HttpError;
    expect(he.code).toBe('confirmation_required');
    expect(he.status).toBe(428);
    expect(he.extra.confirmation?.token).toBeTruthy();
    return he;
  }
  throw new Error('expected a 428 challenge');
}

describe('Confirmations', () => {
  it('issues a 428 challenge when no confirmation is given', () => {
    const { c } = setup();
    const e = challenge(() => c.require(S1, H, typedSpec, undefined));
    expect(e.extra.confirmation).toMatchObject({ level: 'typed', expectedText: 'Prod DB', reasonRequired: true, summary: 'SET on Prod DB' });
    expect(e.extra.confirmation!.token.length).toBeGreaterThanOrEqual(32);
  });

  it('a valid token passes exactly once', () => {
    const { c } = setup();
    const token = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    expect(c.require(S1, H, confirmSpec, { token })).toEqual({});
    challenge(() => c.require(S1, H, confirmSpec, { token }));
  });

  it('is bound to the session', () => {
    const { c } = setup();
    const token = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    const e = challenge(() => c.require(S2, H, confirmSpec, { token }));
    expect(e.message).toMatch(/does not match/);
    // ...and consumed by the failed attempt.
    challenge(() => c.require(S1, H, confirmSpec, { token }));
  });

  it('is bound to the exact request', () => {
    const { c } = setup();
    const token = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    const other = requestHash('cli', 'db1', { line: 'DEL other' });
    challenge(() => c.require(S1, other, confirmSpec, { token }));
    const token2 = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    challenge(() => c.require(S1, requestHash('cli', 'db2', { line: 'DEL k' }), confirmSpec, { token: token2 }));
  });

  it('expires after 2 minutes', () => {
    const { c, advance } = setup();
    const t1 = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    advance(CONFIRM_TTL_MS - 1);
    expect(c.require(S1, H, confirmSpec, { token: t1 })).toEqual({});
    const t2 = challenge(() => c.require(S1, H, confirmSpec, undefined)).extra.confirmation!.token;
    advance(CONFIRM_TTL_MS);
    expect(challenge(() => c.require(S1, H, confirmSpec, { token: t2 })).message).toMatch(/expired or invalid/);
    expect(CONFIRM_TTL_MS).toBe(120_000);
  });

  it('typed confirmations must match the database name; reason required for prod', () => {
    const { c } = setup();
    let token = challenge(() => c.require(S1, H, typedSpec, undefined)).extra.confirmation!.token;
    expect(challenge(() => c.require(S1, H, typedSpec, { token, typed: 'prod db', reason: 'ticket 42' })).message).toMatch(/Typed confirmation/);
    token = challenge(() => c.require(S1, H, typedSpec, undefined)).extra.confirmation!.token;
    expect(challenge(() => c.require(S1, H, typedSpec, { token, typed: 'Prod DB' })).message).toMatch(/reason is required/);
    token = challenge(() => c.require(S1, H, typedSpec, undefined)).extra.confirmation!.token;
    expect(c.require(S1, H, typedSpec, { token, typed: 'Prod DB', reason: 'ticket 42' })).toEqual({ reason: 'ticket 42' });
  });

  it('the spec issued with the token is enforced (cannot be weakened on resubmission)', () => {
    const { c } = setup();
    const token = challenge(() => c.require(S1, H, typedSpec, undefined)).extra.confirmation!.token;
    // The resubmission passes a weaker spec, but the stored one (typed + reason) still applies.
    challenge(() => c.require(S1, H, confirmSpec, { token }));
  });

  it('unknown tokens get a fresh challenge', () => {
    const { c } = setup();
    challenge(() => c.require(S1, H, confirmSpec, { token: 'x'.repeat(43) }));
  });

  it('includes impact when given', () => {
    const { c } = setup();
    const ch = c.issue(S1, H, { ...confirmSpec, impact: { keys: 12, sample: [{ enc: 'utf8', data: 'k1' }] } });
    expect(ch.impact).toEqual({ keys: 12, sample: [{ enc: 'utf8', data: 'k1' }] });
    expect(ch.expectedText).toBeUndefined();
  });
});

describe('Confirmations: flooding', () => {
  it("one session flooding challenges cannot evict another session's pending confirmation", () => {
    const { c } = setup();
    const victim = c.issue(S2, H, confirmSpec);
    for (let i = 0; i < 20_000; i++) c.issue(S1, requestHash('cli', 'db1', { line: `DEL k${i}` }), confirmSpec);
    expect(c.size).toBeLessThanOrEqual(MAX_PENDING_PER_SESSION + 1);
    expect(c.require(S2, H, confirmSpec, { token: victim.token })).toEqual({});
  });
  it('keeps the newest challenges of a session', () => {
    const { c } = setup();
    const tokens = Array.from({ length: MAX_PENDING_PER_SESSION + 5 }, (_, i) => c.issue(S1, requestHash('cli', 'db1', { i }), confirmSpec).token);
    challenge(() => c.require(S1, requestHash('cli', 'db1', { i: 0 }), confirmSpec, { token: tokens[0]! }));
    const last = MAX_PENDING_PER_SESSION + 4;
    expect(c.require(S1, requestHash('cli', 'db1', { i: last }), confirmSpec, { token: tokens[last]! })).toEqual({});
  });
});

describe('requestHash / canonical', () => {
  it('ignores the confirmation field and key order', () => {
    const a = requestHash('ops', 'db', { op: 'key.delete', keys: [{ enc: 'utf8', data: 'k' }] });
    const b = requestHash('ops', 'db', { keys: [{ data: 'k', enc: 'utf8' }], op: 'key.delete', confirmation: { token: 'x'.repeat(20) } });
    expect(a).toBe(b);
  });
  it('differs by route, database and body; array order matters', () => {
    const body = { line: 'DEL a b' };
    expect(requestHash('cli', 'db', body)).not.toBe(requestHash('workbench', 'db', body));
    expect(requestHash('cli', 'db', body)).not.toBe(requestHash('cli', 'db2', body));
    expect(requestHash('cli', 'db', { argv: ['a', 'b'] })).not.toBe(requestHash('cli', 'db', { argv: ['b', 'a'] }));
  });
  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(canonical(null)).toBe('null');
    expect(canonical('s')).toBe('"s"');
  });
});
