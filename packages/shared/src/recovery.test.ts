import { describe, expect, it } from 'vitest';
import { ROUTES, zLocalLogin, zRecoveryCode, zRecoveryCodesRegenerate, zTotpVerify } from './api.ts';

describe('recovery code contract', () => {
  it('the TOTP step takes a six-digit code or a recovery code, never both', () => {
    expect(zTotpVerify.safeParse({ code: '123456' }).success).toBe(true);
    expect(zTotpVerify.safeParse({ recoveryCode: 'abcd-efgh-jkmn' }).success).toBe(true);
    expect(zTotpVerify.safeParse({ code: '123456', recoveryCode: 'abcd-efgh-jkmn' }).success).toBe(false);
    expect(zTotpVerify.safeParse({}).success).toBe(false);
    expect(zTotpVerify.safeParse({ code: '12345' }).success).toBe(false);
  });

  it('login accepts an optional recovery code', () => {
    expect(zLocalLogin.safeParse({ username: 'a', password: 'b' }).success).toBe(true);
    expect(zLocalLogin.parse({ username: 'a', password: 'b', recoveryCode: ' ABCD EFGH JKMN ' }).recoveryCode).toBe('ABCD EFGH JKMN');
  });

  it('a recovery code is short text of letters, digits, spaces and hyphens', () => {
    for (const ok of ['abcd-efgh-jkmn', 'ABCDEFGHJKMN', 'abcd efgh jkmn']) expect(zRecoveryCode.safeParse(ok).success).toBe(true);
    for (const bad of ['short', 'a'.repeat(33), '<abcd-efgh-jk>', 'abcd_efgh_jkmn']) expect(zRecoveryCode.safeParse(bad).success).toBe(false);
  });

  it('regeneration re-authenticates with the password and has a route', () => {
    expect(zRecoveryCodesRegenerate.safeParse({}).success).toBe(false);
    expect(zRecoveryCodesRegenerate.safeParse({ currentPassword: 'x' }).success).toBe(true);
    expect(ROUTES.recoveryCodesRegenerate).toBe('POST /api/v1/auth/recovery-codes');
  });
});
