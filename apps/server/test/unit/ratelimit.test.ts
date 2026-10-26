/** Self-review finding 5: per-IP limits keyed by IPv6 /64, and a bounded bucket map. */
import { describe, expect, it } from 'vitest';
import { clientNet, MAX_BUCKETS, RateLimiter } from '../../src/security/ratelimit.ts';

describe('clientNet', () => {
  it('keys IPv6 by /64 (or the requested prefix) and IPv4 as is', () => {
    expect(clientNet('203.0.113.7')).toBe('203.0.113.7');
    expect(clientNet('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientNet('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientNet('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientNet('2001:DB8:0001:0002:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(clientNet('2001:db8:1:2::1', 48)).toBe('2001:db8:1::/48');
    expect(clientNet('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientNet('::1')).toBe('0:0:0:0::/64');
    expect(clientNet('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(clientNet('not an ip')).toBe('not an ip');
  });

  it('rotating addresses inside one /64 shares one bucket', () => {
    const rl = new RateLimiter(() => 0);
    let ok = 0;
    for (let i = 0; i < 50; i++) if (rl.take(`login:ip:${clientNet(`2001:db8:1:2::${i.toString(16)}`)}`, 1 / 6, 10)) ok++;
    expect(ok).toBe(10);
  });
});

describe('RateLimiter is bounded', () => {
  it('never holds more than its cap, whatever the number of keys', () => {
    let now = 0;
    const rl = new RateLimiter(() => now, 1000);
    for (let i = 0; i < 20_000; i++) {
      now += 1;
      rl.take(`ip:${i}`, 1, 5);
      expect(rl.size).toBeLessThanOrEqual(1000);
    }
  });

  it('drops refilled buckets first and keeps the drained, recently used ones', () => {
    let now = 0;
    const rl = new RateLimiter(() => now, 100);
    // A drained bucket that is still in use.
    for (let i = 0; i < 5; i++) rl.take('victim', 0.00001, 5);
    expect(rl.take('victim', 0.00001, 5)).toBe(false);
    for (let i = 0; i < 1000; i++) {
      now += 2000; // older buckets have refilled by the time the next sweep runs
      rl.take(`spray:${i}`, 1, 1);
      if (i % 10 === 0) expect(rl.take('victim', 0.00001, 5)).toBe(false);
    }
    expect(rl.size).toBeLessThanOrEqual(100);
  });

  it('default cap', () => {
    expect(MAX_BUCKETS).toBe(100_000);
  });
});
