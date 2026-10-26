import { describe, expect, it } from 'vitest';
import { sha256Hex } from './digest.ts';

/** Reference digest from WebCrypto (the same SHA-256 node:crypto and the server use). */
async function reference(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
function random(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
}

describe('sha256Hex (compare-and-set expectations)', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    const t = (s: string) => sha256Hex(new TextEncoder().encode(s));
    expect(t('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(t('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(t('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(t('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  it('equals WebCrypto at every padding boundary and on random binary input', async () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = random(n);
      expect(sha256Hex(bytes)).toBe(await reference(bytes));
    }
    const big = random(300_001);
    expect(sha256Hex(big)).toBe(await reference(big));
  });
});
