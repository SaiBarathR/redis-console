/**
 * Recovery code primitives (src/security/recoveryCodes.ts) and the store's single-use consumption: 60-bit codes from
 * an unbiased 32-character alphabet, forgiving input normalization, argon2id hashes under one salt per set, and a
 * consume that compares hashes in constant time (never an SQL equality), tolerates any input length and succeeds once.
 */
import { describe, expect, it } from 'vitest';
import { generateRecoveryCode, hashRecoveryCode, newRecoveryCodeSet, normalizeRecoveryCode } from '../../src/security/recoveryCodes.ts';
import { openDb } from '../../src/store/db.ts';
import { UserStore } from '../../src/store/users.ts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

describe('recovery code generation and normalization', () => {
  it('12 characters of a 32-symbol alphabet (60 bits), grouped xxxx-xxxx-xxxx, with no modulo bias', () => {
    expect(new Set(ALPHABET).size).toBe(32); // b & 31 over a random byte: 256 = 8 x 32, so every symbol is equally likely
    const seen = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const c = generateRecoveryCode();
      expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
      for (const ch of c.replaceAll('-', '')) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
    expect(seen.size).toBe(32);
    // 24,000 symbols: each expected 750 times; a coarse bound that a biased generator (e.g. % 36) would fail.
    for (const n of seen.values()) expect(n).toBeGreaterThan(550);
  });

  it('normalizes case, spaces, hyphens and the look-alikes o/i/l; anything else is not a code', () => {
    expect(normalizeRecoveryCode(' AB0C-1DEF-GH2J ')).toBe('ab0c1defgh2j');
    expect(normalizeRecoveryCode('abOc iDef LH2j')).toBe('ab0c1def1h2j');
    expect(normalizeRecoveryCode('abcd-efgh-jkm')).toBeNull(); // 11 characters
    expect(normalizeRecoveryCode('abcd-efgh-jkmnp')).toBeNull(); // 13
    expect(normalizeRecoveryCode('abcd-efgh-jkmu')).toBeNull(); // u is not in the alphabet
    expect(normalizeRecoveryCode('abcd-efgh-jk%n')).toBeNull();
  });

  it('a set has distinct codes, one random salt, and argon2id hashes that do not contain the codes', async () => {
    const a = await newRecoveryCodeSet(3);
    const b = await newRecoveryCodeSet(3);
    expect(new Set(a.codes).size).toBe(3);
    expect(a.salt).not.toBe(b.salt);
    for (const [i, code] of a.codes.entries()) {
      expect(a.hashes[i]).toBe(await hashRecoveryCode(normalizeRecoveryCode(code)!, a.salt));
      expect(a.hashes[i]).not.toContain(code.replaceAll('-', ''));
    }
    // Same code, another salt: another hash (a stolen hash does not carry over between sets or users).
    expect(await hashRecoveryCode(normalizeRecoveryCode(a.codes[0]!)!, b.salt)).not.toBe(a.hashes[0]);
  });
});

describe('UserStore.consumeRecoveryCode', () => {
  const setup = async () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    const mk = (username: string) => users.create({ username, displayName: username, role: 'admin', passwordHash: 'x', mustChangePassword: false });
    const alice = mk('alice');
    const bob = mk('bob');
    const setA = await newRecoveryCodeSet(3);
    const setB = await newRecoveryCodeSet(3);
    users.replaceRecoveryCodes(alice.id, setA);
    users.replaceRecoveryCodes(bob.id, setB);
    return { db, users, alice, bob, setA, setB };
  };

  it('consumes a matching unused hash exactly once', async () => {
    const { users, alice, setA } = await setup();
    expect(users.consumeRecoveryCode(alice.id, setA.hashes[1]!)).toBe(true);
    expect(users.consumeRecoveryCode(alice.id, setA.hashes[1]!)).toBe(false);
    expect(users.recoveryCodesRemaining(alice.id)).toBe(2);
  });

  it('refuses another user\'s hash, a near miss, and inputs of any other length without throwing', async () => {
    const { users, alice, bob, setA, setB } = await setup();
    expect(users.consumeRecoveryCode(alice.id, setB.hashes[0]!)).toBe(false);
    const h = setA.hashes[0]!;
    const flipped = h.slice(0, -2) + (h.at(-2) === 'A' ? 'B' : 'A') + h.at(-1);
    expect(flipped).toHaveLength(h.length);
    expect(users.consumeRecoveryCode(alice.id, flipped)).toBe(false);
    // timingSafeEqual throws on a length mismatch; the store must not (a 500 would differ from a wrong code).
    for (const odd of ['', 'x', h.slice(0, -1), `${h}=`, h + h, "' OR 1=1 --"]) expect(users.consumeRecoveryCode(alice.id, odd)).toBe(false);
    expect(users.recoveryCodesRemaining(alice.id)).toBe(3);
    expect(users.recoveryCodesRemaining(bob.id)).toBe(3);
  });

  it('a replaced set no longer works; a reset clears it', async () => {
    const { users, alice, setA } = await setup();
    users.replaceRecoveryCodes(alice.id, await newRecoveryCodeSet(2));
    expect(users.consumeRecoveryCode(alice.id, setA.hashes[0]!)).toBe(false);
    expect(users.resetTotp(alice.id)).toBe(true);
    expect(users.recoveryCodesRemaining(alice.id)).toBe(0);
    expect(users.recoveryCodeSalt(alice.id)).toBeNull();
  });
});
