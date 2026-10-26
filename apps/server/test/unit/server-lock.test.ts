/**
 * Data directory lock (review v0.3 TOTP M1): exclusive creation, a live owner is never displaced, stale locks are
 * recovered (dead pid, a restarted container, a rebooted host, a reused pid, another host's expired lease), and only
 * the owner removes its lock.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireDataDirLock, DataDirLockedError, LEASE_STALE_MS, LOCK_FILE, serverState } from '../../src/store/lock.ts';

const dir = () => mkdtempSync(path.join(tmpdir(), 'rconsole-lockunit-'));
const lockOf = (d: string) => path.join(d, LOCK_FILE);
const write = (d: string, info: Record<string, unknown>, ageMs = 0) => {
  writeFileSync(lockOf(d), `${JSON.stringify({ host: hostname(), startedAt: new Date().toISOString(), nonce: 'theirs', ...info })}\n`);
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(lockOf(d), t, t); }
  return readFileSync(lockOf(d), 'utf8');
};
const read = (d: string) => JSON.parse(readFileSync(lockOf(d), 'utf8')) as Record<string, unknown>;

let other: ChildProcess;
let deadPid: number;
beforeAll(() => {
  // A live process that is not this one, and the pid of one that has exited.
  other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  deadPid = spawnSync(process.execPath, ['-e', 'process.pid'], { stdio: 'ignore' }).pid!;
});
afterAll(() => { other.kill(); });

describe('data directory lock', () => {
  it('is created exclusively and removed by its owner only', () => {
    const d = dir();
    const lock = acquireDataDirLock(d, { owner: 'server', bootId: null });
    expect(read(d)).toMatchObject({ pid: process.pid, host: hostname(), owner: 'server', nonce: lock.info.nonce });
    lock.release();
    expect(existsSync(lockOf(d))).toBe(false);
    // Replaced by someone else: release leaves the new lock alone.
    const again = acquireDataDirLock(d, { owner: 'server', bootId: null });
    const theirs = write(d, { pid: other.pid });
    again.release();
    expect(readFileSync(lockOf(d), 'utf8')).toBe(theirs);
  });

  it('refuses while another live process on this host holds it, without touching the lock', () => {
    const d = dir();
    const theirs = write(d, { pid: other.pid, owner: 'server' });
    let caught: unknown;
    try { acquireDataDirLock(d, { owner: 'server', bootId: null }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DataDirLockedError);
    expect((caught as DataDirLockedError).message).toContain(`a server is running on it (pid ${other.pid}`);
    expect((caught as DataDirLockedError).state.certain).toBe(true);
    // --force never displaces a live owner on this host.
    expect(() => acquireDataDirLock(d, { owner: 'admin rotate-totp-key', force: true, bootId: null })).toThrow(DataDirLockedError);
    expect(readFileSync(lockOf(d), 'utf8')).toBe(theirs);
    expect(serverState(d, null)).toMatchObject({ running: true, certain: true });
  });

  it('recovers a stale lock whose process is gone', () => {
    const d = dir();
    write(d, { pid: deadPid });
    expect(serverState(d, null)).toEqual({ running: false });
    const lock = acquireDataDirLock(d, { owner: 'server', bootId: null });
    expect(read(d)).toMatchObject({ pid: process.pid, nonce: lock.info.nonce });
    lock.release();
  });

  it('recovers a lock naming this very process (a restarted container, where the server is pid 1 again)', () => {
    const d = dir();
    write(d, { pid: process.pid, nonce: 'previous-run' });
    const lock = acquireDataDirLock(d, { owner: 'server', bootId: null });
    expect(read(d).nonce).toBe(lock.info.nonce);
    lock.release();
  });

  it('recovers a lock from before a reboot, and one whose pid was reused (not refreshed)', () => {
    const d = dir();
    write(d, { pid: other.pid, bootId: 'boot-before' });
    const lock = acquireDataDirLock(d, { owner: 'server', bootId: 'boot-now' });
    expect(read(d)).toMatchObject({ nonce: lock.info.nonce, bootId: 'boot-now' });
    lock.release();
    write(d, { pid: other.pid }, LEASE_STALE_MS + 5000);
    expect(serverState(d, null)).toEqual({ running: false });
    acquireDataDirLock(d, { owner: 'server', bootId: null, observeMs: 50 }).release();
  });

  it('a live process with an old lease that refreshes it while watched (a suspended owner waking up) is not displaced', () => {
    const d = dir();
    const theirs = write(d, { pid: other.pid }, LEASE_STALE_MS + 5000);
    // The "owner" refreshes the lease while the newcomer watches it.
    const refresher = spawn(process.execPath, ['-e', `setTimeout(() => { const t = new Date(); require('node:fs').utimesSync(${JSON.stringify(lockOf(d))}, t, t); }, 100)`], { stdio: 'ignore' });
    try {
      expect(() => acquireDataDirLock(d, { owner: 'server', bootId: null, observeMs: 1500 })).toThrow(DataDirLockedError);
    } finally {
      refresher.kill();
    }
    expect(readFileSync(lockOf(d), 'utf8')).toBe(theirs);
  });

  it('another host: a refreshed lease is refused (--force takes it), an expired one is recovered', () => {
    const d = dir();
    write(d, { pid: 1, host: 'elsewhere.example' });
    expect(serverState(d, null)).toMatchObject({ running: true, certain: false });
    expect(() => acquireDataDirLock(d, { owner: 'server', bootId: null })).toThrow(/cannot be checked from here.*Stop it first/);
    acquireDataDirLock(d, { owner: 'admin rotate-totp-key', force: true, bootId: null }).release();
    write(d, { pid: 1, host: 'elsewhere.example' }, LEASE_STALE_MS + 5000);
    expect(serverState(d, null)).toEqual({ running: false });
    acquireDataDirLock(d, { owner: 'server', bootId: null }).release();
  });

  it('an unreadable lock is refused unless forced', () => {
    const d = dir();
    writeFileSync(lockOf(d), 'not json');
    const t = new Date(Date.now() - 10_000);
    utimesSync(lockOf(d), t, t);
    expect(() => acquireDataDirLock(d, { owner: 'server', bootId: null })).toThrow(/cannot be read/);
    expect(serverState(d, null)).toMatchObject({ running: true, unreadable: true });
    acquireDataDirLock(d, { owner: 'admin rotate-totp-key', force: true, bootId: null }).release();
    expect(existsSync(lockOf(d))).toBe(false);
  });
});
