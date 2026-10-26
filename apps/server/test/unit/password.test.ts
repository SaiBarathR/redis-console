import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyDummy, verifyPassword } from '../../src/security/password.ts';

describe('argon2id passwords', () => {
  it('hashes to a PHC string with a random salt', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const h = await hashPassword('s3cret-passphrase!');
    expect(await verifyPassword('s3cret-passphrase!', h)).toBe(true);
    expect(await verifyPassword('s3cret-passphrase', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
    expect(await verifyPassword('S3cret-passphrase!', h)).toBe(false);
  });

  it('handles unicode passwords', async () => {
    const h = await hashPassword('pässwörd-😀-long-enough');
    expect(await verifyPassword('pässwörd-😀-long-enough', h)).toBe(true);
    expect(await verifyPassword('passwörd-😀-long-enough', h)).toBe(false);
  });

  it('malformed or hostile PHC strings verify as false', async () => {
    const h = await hashPassword('x-password-123');
    for (const bad of ['', 'plaintext', '$argon2i$v=19$m=19456,t=2,p=1$abc$def', h.replace('argon2id', 'argon2d'), '$argon2id$v=19$m=99999999,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcGFiY2RlZmdoaWprbG1ub3A', '$argon2id$v=19$m=19456,t=2,p=1$YWJj$YWJj']) {
      expect(await verifyPassword('x-password-123', bad), bad).toBe(false);
    }
  });

  it('verifyDummy always fails', async () => {
    expect(await verifyDummy('anything')).toBe(false);
  });

  it('needsRehash flags weaker parameters', async () => {
    expect(needsRehash(await hashPassword('x-password-123'))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcGFiY2RlZmdoaWprbG1ub3A')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});
