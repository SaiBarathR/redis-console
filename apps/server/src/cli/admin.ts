#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Break-glass admin CLI. Runs on the server host against the data directory, without HTTP.
 *
 *   pnpm --filter @rconsole/server admin status
 *   pnpm --filter @rconsole/server admin reset-totp --user <name>
 *   pnpm --filter @rconsole/server admin reset-totp --all --yes
 *   pnpm --filter @rconsole/server admin rotate-totp-key
 *
 * The data directory and the TOTP key ring come from the server config (RCONSOLE_CONFIG or --config, with
 * RCONSOLE_DATA_DIR applied like the server does). `status` and `reset-totp` need no key: with --data-dir and no
 * config they work when the keys are lost. Output never contains seeds, keys, recovery codes or hashes.
 *
 * Concurrency: the database is SQLite in WAL mode with a busy timeout, and every change here is one short
 * transaction, so `status` and `reset-totp` are safe while the server runs (it re-reads accounts and sessions on
 * every request). `rotate-totp-key` refuses while a server holds the data directory (`server.lock`): the running
 * server could not read seeds under a primary key it was not started with. Restarting the server re-wraps too.
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AuditLog } from '../audit.ts';
import { ConfigError, loadConfig, type AppConfig } from '../config.ts';
import { keyringFromConfig } from '../security/totpCipher.ts';
import { openDb, type Db } from '../store/db.ts';
import { acquireDataDirLock, DataDirLockedError, describeHolder, serverState, type ServerState } from '../store/lock.ts';
import { SessionStore } from '../store/sessions.ts';
import { TotpKeyError, UserStore } from '../store/users.ts';

export const EXIT = { ok: 0, failed: 1, usage: 64, running: 75, config: 78 } as const;

const USAGE = `Redis Console admin CLI (runs on the server host; no HTTP)

Usage:
  admin status [--json]
      Key ids in use (seed counts per key), users with TOTP, unused recovery codes per user. Never secrets.
  admin reset-totp --user <name>
      Clear one local user's TOTP seed, pending enrollment and recovery codes, and sign them out everywhere.
      They enroll again at their next sign-in.
  admin reset-totp --all --yes
      The same for every local user with TOTP state. --yes confirms.
  admin rotate-totp-key
      Re-encrypt every TOTP seed under the primary key (auth.local.totpPrimaryKeyId) and report counts.
      Refused while a server uses the data directory; restarting the server does the same.

Options:
  --config <file>    Server config (default: $RCONSOLE_CONFIG).
  --data-dir <dir>   Data directory (default: server.dataDir of the config, or $RCONSOLE_DATA_DIR).
  --force            rotate-totp-key: proceed when server.lock was written on another host and cannot be checked.
  -h, --help
`;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

class CliError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Target {
  dataDir: string;
  config: AppConfig | undefined;
}

function target(values: { config?: string | undefined; 'data-dir'?: string | undefined }, io: CliIo, needConfig: boolean): Target {
  // Paths typed as flags are relative to where the command was typed. `pnpm --filter @rconsole/server admin` runs the
  // script in apps/server and exports the original directory as INIT_CWD; it is trusted only for that package script,
  // because a shell or tool started from some other pnpm script inherits a stale INIT_CWD, which would silently send a
  // relative --data-dir to another installation. The environment and the config resolve like the server's.
  const viaPackageScript = io.env.npm_lifecycle_event === 'admin' && io.env.npm_package_name === '@rconsole/server';
  const typedIn = viaPackageScript && io.env.INIT_CWD ? io.env.INIT_CWD : io.cwd;
  const configFile = values.config !== undefined ? path.resolve(typedIn, values.config) : io.env.RCONSOLE_CONFIG;
  let config: AppConfig | undefined;
  if (configFile) {
    try {
      config = loadConfig({ env: { ...io.env, RCONSOLE_CONFIG: path.resolve(io.cwd, configFile) }, cwd: io.cwd });
    } catch (e) {
      if (e instanceof ConfigError) throw new CliError(EXIT.config, `${e.message}\n(status and reset-totp also work without a config: pass --data-dir and unset RCONSOLE_CONFIG)`);
      throw e;
    }
  } else if (needConfig) {
    throw new CliError(EXIT.usage, 'this command needs the server config (the TOTP key ring): set RCONSOLE_CONFIG or pass --config');
  }
  const dir = values['data-dir'] !== undefined ? path.resolve(typedIn, values['data-dir']) : config ? config.server.dataDir : io.env.RCONSOLE_DATA_DIR;
  if (!dir) throw new CliError(EXIT.usage, 'no data directory: pass --data-dir, or set RCONSOLE_CONFIG / RCONSOLE_DATA_DIR');
  const dataDir = path.resolve(io.cwd, dir);
  // Never create an empty database in a mistyped directory.
  if (!existsSync(path.join(dataDir, 'rconsole.sqlite'))) {
    const how = values['data-dir'] !== undefined ? '--data-dir' : config ? 'server.dataDir of the config (relative paths resolve against the working directory, as for the server)' : 'RCONSOLE_DATA_DIR';
    throw new CliError(EXIT.failed, `no Redis Console database in ${dataDir} (rconsole.sqlite not found; the directory came from ${how}). Pass --data-dir <the server's data directory>.`);
  }
  return { dataDir, config };
}

const actor = () => {
  let name = 'unknown';
  try {
    name = userInfo().username;
  } catch {
    /* no passwd entry (containers) */
  }
  return { userId: 'cli', username: `cli:${name}`.slice(0, 64), ip: '-' };
};

const describeServer = (s: ServerState) => (s.running ? describeHolder(s) : 'no server is running on it');

function open(dataDir: string, io: CliIo): { db: Db; audit: AuditLog } {
  const db = openDb(dataDir);
  // The audit row goes to the server's append-only table; its JSON copy to stderr keeps stdout readable.
  return { db, audit: new AuditLog(db, (l) => io.err(l)) };
}

function status(t: Target, json: boolean, io: CliIo): number {
  const { db } = open(t.dataDir, io);
  try {
    const users = new UserStore(db);
    const rows = users.totpInventory();
    const ring = t.config?.local?.totpKeyring;
    const ringIds = ring?.keys.map((k) => k.id);
    const byKey = new Map<string, number>();
    for (const r of rows) for (const v of [r.seed, r.pending]) if (v) byKey.set(v, (byKey.get(v) ?? 0) + 1);
    const notInRing = ringIds ? [...byKey.keys()].filter((k) => k.startsWith('v2:') && !ringIds.includes(k.slice(3))) : [];
    const totpUsers = rows.filter((r) => r.seed);
    const server = serverState(t.dataDir);
    if (json) {
      io.out(`${JSON.stringify({
        dataDir: t.dataDir,
        serverRunning: server.running,
        keyRing: ring ? { keyIds: ringIds, primaryKeyId: ring.primaryId } : null,
        storedSeedsByKey: Object.fromEntries(byKey),
        keyIdsNotInRing: notInRing.map((k) => k.slice(3)),
        localUsers: rows.length,
        usersWithTotp: totpUsers.length,
        users: rows.filter((r) => r.seed || r.pending || r.recoveryRemaining || r.recoveryUsed)
          .map((r) => ({ username: r.username, totp: r.seed, pending: r.pending, recoveryCodesRemaining: r.recoveryRemaining, recoveryCodesUsed: r.recoveryUsed })),
      }, null, 2)}\n`);
      return EXIT.ok;
    }
    const lines: string[] = [];
    lines.push(`Data directory: ${t.dataDir} (${describeServer(server)})`);
    lines.push(ring ? `TOTP key ring (config): ${ringIds!.join(', ')}; primary: ${ring.primaryId}` : 'TOTP key ring: not loaded (no config given)');
    lines.push('Stored TOTP seeds by format and key id (seeds and pending enrollments):');
    if (!byKey.size) lines.push('  (none)');
    for (const [k, n] of [...byKey].sort()) {
      const note = k === 'plain' ? '  clear text from before F-05; encrypted at the next start'
        : k === 'v1' ? '  re-wrapped to v2 at the next start'
          : k === 'malformed' ? '  NOT A SEED (corrupted): the server refuses to start; reset these users'
            : notInRing.includes(k) ? '  NOT IN THE KEY RING: the server refuses to start' : '';
      lines.push(`  ${k.padEnd(28)} ${String(n).padStart(4)}${note}`);
    }
    lines.push(`Local users: ${rows.length}; with TOTP: ${totpUsers.length}`);
    const shown = rows.filter((r) => r.seed || r.pending || r.recoveryRemaining || r.recoveryUsed);
    if (shown.length) {
      const w = Math.max(8, ...shown.map((r) => r.username.length));
      lines.push(`  ${'USER'.padEnd(w)}  ${'TOTP'.padEnd(20)}  ${'PENDING'.padEnd(20)}  RECOVERY CODES LEFT`);
      for (const r of shown) {
        lines.push(`  ${r.username.padEnd(w)}  ${(r.seed ?? '-').padEnd(20)}  ${(r.pending ?? '-').padEnd(20)}  ${r.seed ? `${r.recoveryRemaining} (${r.recoveryUsed} used)` : '-'}`);
      }
    }
    if (notInRing.length) {
      lines.push(`Key id(s) in use but not in the ring: ${notInRing.map((k) => k.slice(3)).join(', ')}. Put the key back, or reset those users with \`admin reset-totp\`.`);
    }
    io.out(`${lines.join('\n')}\n`);
    return EXIT.ok;
  } finally {
    db.close();
  }
}

function resetTotp(t: Target, values: { user?: string | undefined; all?: boolean | undefined; yes?: boolean | undefined }, io: CliIo): number {
  if (!!values.user === !!values.all) throw new CliError(EXIT.usage, 'reset-totp needs exactly one of --user <name> or --all');
  const { db, audit } = open(t.dataDir, io);
  try {
    // No key ring: resetting never needs to decrypt, so it also works when the keys are lost.
    const users = new UserStore(db);
    const sessions = new SessionStore(db, { ttlMs: 1, idleMs: 1 });
    const server = serverState(t.dataDir);
    if (server.running) io.err(`Note: ${describeServer(server)}. That is safe: each reset is one short SQLite transaction, and the server re-reads accounts and sessions on every request.\n`);
    let targets: { id: string; username: string }[];
    if (values.user) {
      const u = users.byUsername(values.user);
      if (!u) throw new CliError(EXIT.failed, `no local user named "${values.user}"`);
      targets = [{ id: u.id, username: u.username }];
    } else {
      targets = users.totpInventory().filter((r) => r.seed || r.pending || r.recoveryRemaining || r.recoveryUsed);
      if (!values.yes) {
        io.out(`Data directory: ${t.dataDir}\nThis would clear TOTP and recovery codes for ${targets.length} local user(s) and sign them out everywhere:\n${targets.map((r) => `  ${r.username}`).join('\n') || '  (none)'}\nRun again with --yes to do it.\n`);
        return EXIT.usage;
      }
    }
    const who = actor();
    let revoked = 0;
    for (const u of targets) {
      users.transaction(() => {
        users.resetTotp(u.id);
        revoked += sessions.destroyUser(u.id);
      });
      audit.record({ ...who, action: 'admin.cli.reset-totp', outcome: 'allowed', detail: `user=${u.username}${values.all ? ' (--all)' : ''}; seed, pending enrollment and recovery codes cleared; sessions revoked` });
    }
    io.out(`Data directory: ${t.dataDir}\nReset TOTP for ${targets.length} user(s)${targets.length ? `: ${targets.map((u) => u.username).join(', ')}` : ''}. ${revoked} session(s) revoked. They enroll again at their next sign-in.\n`);
    return EXIT.ok;
  } finally {
    db.close();
  }
}

function rotate(t: Target, force: boolean, io: CliIo): number {
  const keyring = keyringFromConfig(t.config?.local?.totpKeyring);
  if (!t.config?.local?.enabled || !keyring) throw new CliError(EXIT.config, 'the config has no local accounts with a TOTP key ring (auth.local.totpEncryptionKey(s))');
  // Hold the data directory like a server does, for the whole re-wrap (review v0.3 TOTP M1): refused while a server
  // owns it, and no server can start in the meantime. --force only takes over a lock that cannot be checked.
  let lock;
  try {
    lock = acquireDataDirLock(t.dataDir, { owner: 'admin rotate-totp-key', force });
  } catch (e) {
    if (!(e instanceof DataDirLockedError)) throw e;
    const server = e.state;
    throw new CliError(
      EXIT.running,
      `refusing to re-wrap: ${describeServer(server)}. A running server could not read seeds under a primary key it was not started with. ` +
        `Restart the server instead (startup re-wraps every seed to the primary key), or stop it and run this again.${server.certain ? '' : ' If no server uses this directory any more, add --force.'}`,
    );
  }
  const { db, audit } = open(t.dataDir, io);
  try {
    const users = new UserStore(db, { totpKeyring: keyring });
    let r;
    try {
      r = users.migrateTotpSeeds();
    } catch (e) {
      if (!(e instanceof TotpKeyError)) throw e;
      audit.record({ ...actor(), action: 'admin.cli.rotate-totp-key', outcome: 'error', detail: `${e.affectedUsers} user(s) with undecryptable seeds; nothing changed` });
      throw new CliError(EXIT.failed, e.message);
    }
    audit.record({ ...actor(), action: 'admin.cli.rotate-totp-key', outcome: 'allowed', detail: `encrypted=${r.encrypted} rewrapped=${r.rewrapped} users=${r.users} primary=${keyring.primaryId}` });
    io.out(
      `Data directory: ${t.dataDir}\nPrimary key: ${keyring.primaryId}. Re-wrapped ${r.rewrapped} seed(s), encrypted ${r.encrypted} legacy clear-text seed(s); ` +
        `every stored seed of ${r.users} user(s) is now under "${keyring.primaryId}". Keys no longer used by any seed can be removed from the ring.\n`,
    );
    return EXIT.ok;
  } finally {
    db.close();
    lock.release();
  }
}

export function runAdmin(argv: string[], io: CliIo): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        user: { type: 'string' },
        all: { type: 'boolean' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if (values.help || !cmd) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? EXIT.ok : EXIT.usage;
  }
  try {
    if (positionals.length > 1) throw new CliError(EXIT.usage, `unexpected argument: ${positionals[1]}`);
    switch (cmd) {
      case 'status':
        return status(target(values, io, false), !!values.json, io);
      case 'reset-totp':
        return resetTotp(target(values, io, false), values, io);
      case 'rotate-totp-key':
        return rotate(target(values, io, true), !!values.force, io);
      default:
        throw new CliError(EXIT.usage, `unknown command: ${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`admin ${cmd}: ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = runAdmin(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}
