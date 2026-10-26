import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { SessionStore, hashToken, type Session } from '../../src/store/sessions.ts';

const MIN = 60_000;

function setup() {
  let now = 1_700_000_000_000;
  const db = openDb(':memory:');
  const store = new SessionStore(db, { ttlMs: 60 * MIN, idleMs: 10 * MIN, now: () => now });
  const advance = (ms: number) => {
    now += ms;
  };
  const base = { userId: 'u1', username: 'alice', displayName: 'Alice', source: 'local' as const, role: 'operator' as const, ip: '127.0.0.1' };
  return { db, store, advance, base, now: () => now };
}

describe('SessionStore', () => {
  it('stores only the SHA-256 of the session id', () => {
    const { db, store, base } = setup();
    const { id, session } = store.create({ ...base, state: 'active' });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(session.idHash).toBe(createHash('sha256').update(id).digest('hex'));
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(id);
    expect(store.get(id)?.userId).toBe('u1');
    expect(store.get(session.idHash)).toBeNull(); // the hash itself is not a credential
  });

  it('ignores missing, short or oversized ids', () => {
    const { store } = setup();
    expect(store.get(undefined)).toBeNull();
    expect(store.get('short')).toBeNull();
    expect(store.get('x'.repeat(500))).toBeNull();
    expect(store.get('x'.repeat(43))).toBeNull();
  });

  it('expires after the idle timeout and deletes the row', () => {
    const { db, store, base, advance } = setup();
    const { id } = store.create({ ...base, state: 'active' });
    advance(10 * MIN - 1);
    expect(store.get(id)).not.toBeNull();
    advance(1);
    expect(store.get(id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
  });

  it('touch slides the idle window (rate-limited writes) but not the absolute lifetime', () => {
    const { store, base, advance } = setup();
    const { id } = store.create({ ...base, state: 'active' });
    for (let i = 0; i < 5; i++) {
      advance(9 * MIN);
      const s = store.get(id)!;
      expect(s).not.toBeNull();
      store.touch(s);
    }
    // 45 minutes in, still alive thanks to activity; absolute expiry at 60 minutes.
    advance(9 * MIN);
    store.touch(store.get(id)!);
    advance(7 * MIN); // 61 minutes since creation
    expect(store.get(id)).toBeNull();
  });

  it('touch does not write more often than every 15 s', () => {
    const { store, base, advance } = setup();
    const { id } = store.create({ ...base, state: 'active' });
    const s = store.get(id)!;
    advance(5_000);
    store.touch(s);
    expect(store.get(id)!.lastSeenAt).toBe(s.createdAt);
    advance(15_000);
    store.touch(s);
    expect(store.get(id)!.lastSeenAt).toBe(s.createdAt + 20_000);
  });

  it('effectiveExpiry is the earlier of idle and absolute expiry', () => {
    const { store, base, advance } = setup();
    const { id } = store.create({ ...base, state: 'active' });
    let s = store.get(id)!;
    expect(store.effectiveExpiry(s)).toBe(s.lastSeenAt + 10 * MIN);
    for (let i = 0; i < 6; i++) {
      advance(9 * MIN);
      s = store.get(id)!;
      store.touch(s);
    }
    expect(store.effectiveExpiry(s)).toBe(s.expiresAt);
  });

  it('rotate issues a new id and CSRF token; the old id stops working', () => {
    const { store, base, advance } = setup();
    const { id, session } = store.create({ ...base, state: 'active' });
    advance(MIN);
    const r = store.rotate(session, { role: 'admin' });
    expect(r.id).not.toBe(id);
    expect(r.session.csrfToken).not.toBe(session.csrfToken);
    expect(store.get(id)).toBeNull();
    const fresh = store.get(r.id)!;
    expect(fresh.role).toBe('admin');
    // Absolute lifetime does not restart on a plain rotation.
    expect(fresh.expiresAt).toBe(session.expiresAt);
    expect(fresh.createdAt).toBe(session.createdAt);
  });

  it('pending (TOTP) sessions expire after 5 minutes and become active on rotate', () => {
    const { store, base, advance, now } = setup();
    const p = store.create({ ...base, state: 'totp_pending' });
    expect(p.session.expiresAt).toBe(now() + 5 * MIN);
    advance(4 * MIN);
    const got = store.get(p.id)!;
    expect(got.state).toBe('totp_pending');
    const r = store.rotate(got, { state: 'active' });
    expect(r.session.state).toBe('active');
    expect(r.session.expiresAt).toBe(now() + 60 * MIN);
    expect(store.get(p.id)).toBeNull();

    const p2 = store.create({ ...base, state: 'totp_pending' });
    advance(5 * MIN);
    expect(store.get(p2.id)).toBeNull();
  });

  it('pending sessions are not subject to the idle timeout check while valid', () => {
    const db = openDb(':memory:');
    let now = 0;
    const store = new SessionStore(db, { ttlMs: 60 * MIN, idleMs: 1 * MIN, now: () => now });
    const p = store.create({ userId: 'u', username: 'u', displayName: 'u', source: 'local', role: 'admin', ip: '-', state: 'totp_pending' });
    now += 2 * MIN;
    expect(store.get(p.id)?.state).toBe('totp_pending');
  });

  it('destroy / destroyUser (optionally keeping one session)', () => {
    const { store, base } = setup();
    const a = store.create({ ...base, state: 'active' });
    const b = store.create({ ...base, state: 'active' });
    const c = store.create({ ...base, state: 'active' });
    const other = store.create({ ...base, userId: 'u2', state: 'active' });
    expect(store.destroyUser('u1', b.session.idHash)).toBe(2);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(c.id)).toBeNull();
    expect(store.get(b.id)).not.toBeNull();
    expect(store.get(other.id)).not.toBeNull();
    store.destroy(b.session);
    expect(store.get(b.id)).toBeNull();
    expect(store.destroyUser('u2')).toBe(1);
  });

  it('purgeExpired removes idle and absolute-expired sessions', () => {
    const { db, store, base, advance } = setup();
    store.create({ ...base, state: 'active' });
    store.create({ ...base, state: 'totp_pending' });
    advance(6 * MIN);
    const live = store.create({ ...base, state: 'active' });
    expect(store.purgeExpired()).toBe(1); // the pending one
    advance(5 * MIN);
    expect(store.purgeExpired()).toBe(1); // the first active one (idle 11 min)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    expect(store.get(live.id)).not.toBeNull();
  });

  it('alive() reflects deletion and expiry by hash', () => {
    const { store, base, advance } = setup();
    const { session } = store.create({ ...base, state: 'active' });
    expect(store.alive(session.idHash)).toBe(true);
    advance(10 * MIN);
    expect(store.alive(session.idHash)).toBe(false);
    const s2: Session = store.create({ ...base, state: 'active' }).session;
    store.destroy(s2);
    expect(store.alive(s2.idHash)).toBe(false);
    expect(store.alive(hashToken('nope'))).toBe(false);
  });

  it('keeps idToken server-side when given', () => {
    const { store, base } = setup();
    const { id } = store.create({ ...base, source: 'oidc', state: 'active', idToken: 'eyJ.token' });
    expect(store.get(id)!.idToken).toBe('eyJ.token');
  });
});

describe('OIDC session lifetime (self-review finding 7)', () => {
  it('a shorter per-session TTL ends the session early; it can never extend the server TTL', () => {
    const { store, advance, base } = setup();
    const { id: short } = store.create({ ...base, source: 'oidc', state: 'active' }, { ttlMs: 15 * MIN });
    const { id: long } = store.create({ ...base, source: 'oidc', state: 'active' }, { ttlMs: 600 * MIN });
    /** Use both sessions every 5 minutes (well inside the 10 min idle timeout). */
    const use = (id: string) => {
      const s = store.get(id);
      if (s) store.touch(s);
      return s;
    };
    for (let t = 5; t <= 10; t += 5) {
      advance(5 * MIN);
      expect(use(short), `${t} min`).not.toBeNull();
      expect(use(long)).not.toBeNull();
    }
    advance(5 * MIN); // 15 min
    expect(use(short)).toBeNull();
    expect(use(long)).not.toBeNull();
    for (let t = 20; t < 60; t += 5) {
      advance(5 * MIN);
      expect(use(long), `${t} min`).not.toBeNull();
    }
    advance(5 * MIN); // 60 min: the server TTL, not 600
    expect(use(long)).toBeNull();
  });
});
