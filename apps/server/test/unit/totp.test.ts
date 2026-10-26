import { describe, expect, it } from 'vitest';
import { TOTP_PERIOD, base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totpCode, totpStep, verifyTotp } from '../../src/security/totp.ts';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890"; 8-digit values, last 6 digits shown by 6-digit TOTP.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(VECTORS)('RFC 6238 vector at T=%i', (t, eight) => {
    expect(totpCode(SECRET, t * 1000)).toBe(eight.slice(-6));
  });

  it('RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 3, 4].map((i) => hotp(key, i))).toEqual(['755224', '287082', '359152', '969429', '338314']);
  });

  it('base32 round trip, padding/whitespace tolerant, rejects invalid characters', () => {
    for (const n of [0, 1, 5, 10, 20, 33]) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZ1W')).toThrow(/invalid base32/);
  });

  it('generates 160-bit secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
  });

  it('accepts the current step and ±1, rejects ±2', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    const at = (dSteps: number) => totpCode(SECRET, now + dSteps * TOTP_PERIOD * 1000);
    expect(verifyTotp(SECRET, at(0), 0, now)).toBe(step);
    expect(verifyTotp(SECRET, at(-1), 0, now)).toBe(step - 1);
    expect(verifyTotp(SECRET, at(1), 0, now)).toBe(step + 1);
    expect(verifyTotp(SECRET, at(-2), 0, now)).toBeNull();
    expect(verifyTotp(SECRET, at(2), 0, now)).toBeNull();
  });

  it('rejects replays (step <= last used step)', () => {
    const now = 1_700_000_015_000;
    const code = totpCode(SECRET, now);
    const step = verifyTotp(SECRET, code, 0, now)!;
    expect(verifyTotp(SECRET, code, step, now)).toBeNull();
    // An older (previous-step) code is also refused once a newer step was used.
    expect(verifyTotp(SECRET, totpCode(SECRET, now - 30_000), step, now)).toBeNull();
    // The next step is still accepted.
    expect(verifyTotp(SECRET, totpCode(SECRET, now + 30_000), step, now)).toBe(step + 1);
  });

  it('rejects malformed codes', () => {
    for (const c of ['', '12345', '1234567', 'abcdef', '12 456', '-12345']) expect(verifyTotp(SECRET, c, 0)).toBeNull();
    expect(verifyTotp(SECRET, '000000', 0, 59_000)).toBeNull();
  });

  it('builds an otpauth:// URL', () => {
    const u = new URL(otpauthUrl('Redis Console', 'alice', 'ABC234'));
    expect(u.protocol).toBe('otpauth:');
    expect(otpauthUrl('Redis Console', 'alice', 'ABC234')).toMatch(/^otpauth:\/\/totp\/Redis%20Console%3Aalice\?/);
    expect(u.searchParams.get('secret')).toBe('ABC234');
    expect(u.searchParams.get('issuer')).toBe('Redis Console');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(otpauthUrl('Redis Console', 'alice', 'ABC234')).toContain('issuer=Redis%20Console');
  });
});
