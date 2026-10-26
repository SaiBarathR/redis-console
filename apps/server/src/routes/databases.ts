import type { FastifyInstance } from 'fastify';
import { minRole, type DatabaseOverview, type DatabaseSummary, type DatabasesResponse, type MetricsSample } from '@rconsole/shared';
import { audit, dbScope, profilerAllowed, requireSession, type AppContext } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { openSse } from '../http/sse.ts';
import { METADATA_REPLY_BYTES, sanitizeRedisError, TM_STR, withTimeout, type Conn } from '../redis/manager.ts';
import { asStr, parseInfo } from '../redis/reply.ts';
import { HIDDEN_INFO_FIELDS } from './infoFields.ts';
import { maskListener } from '../policy/redactReply.ts';


export function sanitizeInfo(info: Record<string, Record<string, string>>, hideAddresses = false): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [section, fields] of Object.entries(info)) {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (HIDDEN_INFO_FIELDS.has(k)) continue;
      if (/^slave\d+$/.test(k) || /^replica\d+$/.test(k)) {
        o[k] = v.replace(/ip=[^,]*/g, 'ip=<hidden>').replace(/port=\d+/g, 'port=<hidden>');
        continue;
      }
      if (hideAddresses && /^listener\d+$/.test(k)) {
        o[k] = maskListener(v);
        continue;
      }
      o[k] = v;
    }
    out[section] = o;
  }
  return out;
}

export async function fetchInfo(conn: Conn, section?: string): Promise<Record<string, Record<string, string>>> {
  const raw = await conn.send(section ? ['INFO', section] : ['INFO'], { typeMapping: TM_STR, timeout: 5000, maxBytes: METADATA_REPLY_BYTES });
  return parseInfo(asStr(raw));
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseKeyspace(info: Record<string, Record<string, string>>) {
  const out: DatabaseOverview['keyspace'] = [];
  for (const [k, v] of Object.entries(info.keyspace ?? {})) {
    const m = /^db(\d+)$/.exec(k);
    if (!m) continue;
    const f = Object.fromEntries(v.split(',').map((p) => p.split('=') as [string, string]));
    out.push({ db: Number(m[1]), keys: num(f.keys), expires: num(f.expires), avgTtl: num(f.avg_ttl) });
  }
  return out;
}

function parseModules(info: Record<string, Record<string, string>>) {
  const mods: { name: string; version: string }[] = [];
  for (const [k, v] of Object.entries(info.modules ?? {})) {
    if (!k.startsWith('module')) continue;
    const f = Object.fromEntries(v.split(',').map((p) => p.split('=') as [string, string]));
    if (f.name) mods.push({ name: f.name, version: f.ver ?? '' });
  }
  return mods;
}

export function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext) {
  const serverInfo = new Map<string, { at: number; server: NonNullable<DatabaseSummary['server']> }>();

  app.get('/api/v1/databases', async (req): Promise<DatabasesResponse> => {
    const s = requireSession(req);
    const databases = await Promise.all(
      ctx.redis.list().map(async (db): Promise<DatabaseSummary> => {
        const role = minRole(s.role, db.maxRole);
        const out: DatabaseSummary = {
          id: db.id, name: db.name, environment: db.environment, readOnly: db.readOnly, effectiveRole: role,
          features: { profiler: profilerAllowed(ctx, db.environment, role) },
          status: 'connecting',
          db: db.db,
        };
        if (db.description) out.description = db.description;
        if (db.tags?.length) out.tags = db.tags;
        try {
          const conn = await withTimeout(ctx.redis.conn(db.id, role), 2500, 'connect timeout');
          let cached = serverInfo.get(db.id);
          if (!cached || Date.now() - cached.at > 60_000) {
            const info = parseInfo(asStr(await withTimeout(conn.send(['INFO', 'server', 'modules'], { typeMapping: TM_STR, timeout: 2500, maxBytes: METADATA_REPLY_BYTES }), 2500, 'INFO timeout')));
            cached = {
              at: Date.now(),
              server: {
                version: info.server?.redis_version ?? 'unknown',
                mode: db.mode,
                modules: parseModules(info),
              },
            };
            serverInfo.set(db.id, cached);
          } else {
            await withTimeout(conn.send(['PING'], { timeout: 2000 }), 2500, 'PING timeout');
          }
          out.status = 'connected';
          out.server = cached.server;
        } catch (e) {
          // HttpErrors come from the manager (no credentials for this tier, connection failed): definitive.
          // A plain timeout means the connection attempt is still in progress.
          const st = ctx.redis.status(db.id, role);
          out.status = !(e instanceof HttpError) && st.status === 'connecting' ? 'connecting' : 'error';
          out.statusMessage = sanitizeRedisError(e).replace(/^cannot connect to database: /, '');
        }
        return out;
      }),
    );
    return { databases };
  });

  app.get('/api/v1/databases/:db/overview', async (req): Promise<DatabaseOverview> => {
    const scope = dbScope(ctx, req);
    const conn = await scope.conn();
    const info = await fetchInfo(conn);
    let keyspace = parseKeyspace(info);
    if (conn.mode === 'cluster') {
      // Sum keyspace across primaries.
      const all = await Promise.all((await conn.primaries()).map(async (t) => parseKeyspace(parseInfo(asStr(await t.send(['INFO', 'keyspace'], { typeMapping: TM_STR, maxBytes: METADATA_REPLY_BYTES }))))));
      const byDb = new Map<number, DatabaseOverview['keyspace'][number]>();
      for (const ks of all) for (const k of ks) {
        const cur = byDb.get(k.db) ?? { db: k.db, keys: 0, expires: 0, avgTtl: 0 };
        cur.keys += k.keys;
        cur.expires += k.expires;
        cur.avgTtl = Math.max(cur.avgTtl, k.avgTtl);
        byDb.set(k.db, cur);
      }
      keyspace = [...byDb.values()];
    }
    const st = info.stats ?? {};
    const hits = num(st.keyspace_hits), misses = num(st.keyspace_misses);
    const mem = info.memory ?? {};
    return {
      id: scope.db.id,
      info: sanitizeInfo(info, scope.role !== 'admin'),
      keyspace,
      memory: {
        used: num(mem.used_memory),
        peak: num(mem.used_memory_peak),
        maxmemory: num(mem.maxmemory),
        fragmentationRatio: num(mem.mem_fragmentation_ratio),
        policy: mem.maxmemory_policy ?? '',
      },
      clients: { connected: num(info.clients?.connected_clients), blocked: num(info.clients?.blocked_clients) },
      stats: {
        opsPerSec: num(st.instantaneous_ops_per_sec),
        hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
        totalCommands: num(st.total_commands_processed),
        evictedKeys: num(st.evicted_keys),
        expiredKeys: num(st.expired_keys),
      },
      uptimeSeconds: num(info.server?.uptime_in_seconds),
    };
  });

  app.get('/api/v1/databases/:db/metrics/stream', async (req, reply) => {
    const scope = dbScope(ctx, req);
    await fetchInfo(await scope.conn(), 'server'); // fail before opening the stream if the database is down
    const sse = openSse(ctx, req, reply, { maxMs: 60 * 60_000, kind: 'metrics', limit: 5 });
    let prev: { t: number; hits: number; misses: number; cpuSys: number; cpuUser: number } | undefined;
    const tick = async () => {
      try {
        // Looked up on every tick: a reset replaces the tier's connection (review v0.2 M3).
        const conn = await ctx.redis.conn(scope.db.id, scope.role);
        const info = parseInfo(asStr(await conn.send(['INFO', 'stats', 'memory', 'clients', 'cpu'], { typeMapping: TM_STR, timeout: 3000, maxBytes: METADATA_REPLY_BYTES })));
        const t = Date.now();
        const st = info.stats ?? {};
        const cpu = info.cpu ?? {};
        const cur = { t, hits: num(st.keyspace_hits), misses: num(st.keyspace_misses), cpuSys: num(cpu.used_cpu_sys), cpuUser: num(cpu.used_cpu_user) };
        let hitRate: number | null = null;
        let cpuSys = 0, cpuUser = 0;
        if (prev) {
          const dh = cur.hits - prev.hits, dm = cur.misses - prev.misses;
          hitRate = dh + dm > 0 ? dh / (dh + dm) : null;
          const dt = (cur.t - prev.t) / 1000;
          if (dt > 0) {
            cpuSys = Math.max(0, ((cur.cpuSys - prev.cpuSys) / dt) * 100);
            cpuUser = Math.max(0, ((cur.cpuUser - prev.cpuUser) / dt) * 100);
          }
        }
        prev = cur;
        const sample: MetricsSample = {
          t,
          opsPerSec: num(st.instantaneous_ops_per_sec),
          usedMemory: num(info.memory?.used_memory),
          connectedClients: num(info.clients?.connected_clients),
          hitRate,
          netInputKbps: num(st.instantaneous_input_kbps),
          netOutputKbps: num(st.instantaneous_output_kbps),
          cpuSys: Math.round(cpuSys * 100) / 100,
          cpuUser: Math.round(cpuUser * 100) / 100,
        };
        sse.send(sample);
      } catch (e) {
        sse.send({ message: sanitizeRedisError(e) }, 'error');
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    sse.onClose(() => clearInterval(timer));
    audit(ctx, req, { action: 'metrics.stream', outcome: 'allowed', databaseId: scope.db.id });
  });
}
