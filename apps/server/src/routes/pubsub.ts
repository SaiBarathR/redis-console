import type { FastifyInstance } from 'fastify';
import {
  KEY_ELEMENT_PREVIEW_BYTES,
  binFromBytes,
  zPubSubChannels,
  zPubSubSubscribe,
  zPublish,
  type ProfilerEvent,
  type PubSubChannels,
  type PubSubMessage,
  type PubSubSubscription,
  type PublishResponse,
} from '@rconsole/shared';
import { z } from 'zod';
import { failureDetail } from '../audit.ts';
import { audit, dbScope, parse, profilerAllowed, rateLimit, type AppContext } from '../context.ts';
import { clientIsGone } from '../http/clientGone.ts';
import { HttpError } from '../http/errors.ts';
import { openSse, reserveSse } from '../http/sse.ts';
import { auditDenied, auditedRead, confirmOrThrow } from '../policy/enforce.ts';
import { authorize, checkGlob, classify, confirmationFor } from '../policy/policy.ts';
import { buildPreview, previewCommand } from '../policy/preview.ts';
import { run, toHttpError } from '../redis/exec.ts';
import { TM_STR, type DedicatedClient } from '../redis/manager.ts';
import { asNum, asStr } from '../redis/reply.ts';

const PUBSUB_MAX_MS = 15 * 60_000;
/**
 * Messages larger than this are cut (flagged `truncated`, with `totalBytes`). The dedicated socket keeps no more than
 * this of any message, so an oversized message is shown cut instead of ending the stream.
 */
export const PUBSUB_MESSAGE_PREVIEW_BYTES = KEY_ELEMENT_PREVIEW_BYTES;
const PROFILER_MAX_SECONDS = 60;
const MAX_EVENTS_PER_SECOND = 200;

const MAX_SUBSCRIPTIONS = 10;
/** The stream takes only the opaque id from POST /pubsub/subscriptions (channel names never in a URL). */
const zStreamQuery = z.object({ sub: z.string().min(16).max(256) }).strict();
const zProfilerQuery = z.object({ seconds: z.coerce.number().int().min(1).max(PROFILER_MAX_SECONDS).default(30) }).strict();

/**
 * Parse a MONITOR line: `1700000000.123456 [0 127.0.0.1:5000] "SET" "k" "v"`. Args truncated to 64 chars.
 * Linear scan (no backtracking regex): MONITOR shows other clients' arguments, which anyone can craft.
 * `cut`: only the start of a longer line was kept; its last, unterminated argument is shown with an ellipsis.
 */
export function parseMonitorLine(line: string, cut = false): ProfilerEvent | null {
  const head = /^(\d+(?:\.\d+)?) \[(\d+) ([^\]]{0,256})\] /.exec(line.slice(0, 400));
  if (!head) return null;
  const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b' };
  const argv: string[] = [];
  const n = line.length;
  let i = head[0].length;
  while (i < n && argv.length < 64) {
    while (i < n && line[i] !== '"') i++;
    if (i >= n) break;
    i++;
    let arg = '';
    let full = false;
    let closed = false;
    while (i < n) {
      const c = line[i]!;
      if (c === '"') {
        closed = true;
        i++;
        break;
      }
      let ch = c;
      if (c === '\\' && i + 1 < n) {
        const e = line[i + 1]!;
        if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
          ch = String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
          i += 4;
        } else {
          ch = ESC[e] ?? e;
          i += 2;
        }
      } else {
        i++;
      }
      if (!full) {
        if (arg.length < 64) arg += ch;
        else full = true;
      }
    }
    if (!closed) {
      if (cut) argv.push(`${arg}…`);
      break;
    }
    argv.push(full ? `${arg}…` : arg);
  }
  return { t: Math.round(Number(head[1]) * 1000), db: Number(head[2]), client: head[3]!, argv };
}

export function registerPubSubRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  // Pattern in the body, not the URL; read-only, no confirmation.
  app.post('/api/v1/databases/:db/pubsub/channels', { bodyLimit: 16 * 1024 }, async (req): Promise<PubSubChannels> => {
    const scope = dbScope(ctx, req);
    const q = parse(zPubSubChannels, req.body);
    // Channel names are data like key names (review v0.2 round 2, R2-M4): one audit event, the pattern as a size only.
    const base = { action: 'pubsub.channels', databaseId: scope.db.id, command: 'PUBSUB CHANNELS', argvRedacted: ['PUBSUB', 'CHANNELS', `<${Buffer.byteLength(q.pattern)} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      checkGlob(q.pattern);
      const conn = await scope.conn();
      const names = (await run<unknown[]>(conn, ['PUBSUB', 'CHANNELS', q.pattern], { typeMapping: TM_STR })).map(asStr).slice(0, 1000);
      const channels: PubSubChannels['channels'] = [];
      for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        const flat = await run<unknown[]>(conn, ['PUBSUB', 'NUMSUB', ...chunk], { typeMapping: TM_STR });
        for (let j = 0; j + 1 < flat.length; j += 2) channels.push({ name: asStr(flat[j]), subscribers: asNum(flat[j + 1]) });
      }
      const patterns = asNum(await run(conn, ['PUBSUB', 'NUMPAT']));
      channels.sort((a, b) => b.subscribers - a.subscribers || a.name.localeCompare(b.name));
      return { channels, patterns };
    }, (r) => `channels=${r.channels.length}`);
  });

  // Step 1: validate the channels/patterns and hand out a single-use, 60 s, session-bound subscription id.
  app.post('/api/v1/databases/:db/pubsub/subscriptions', { bodyLimit: 64 * 1024 }, async (req): Promise<PubSubSubscription> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'pubsub-sub', 10, 20);
    const body = parse(zPubSubSubscribe, req.body);
    if (!body.channels.length && !body.patterns.length) throw new HttpError('validation', 'Give at least one channel or pattern.');
    if (body.channels.length + body.patterns.length > MAX_SUBSCRIPTIONS) throw new HttpError('validation', `At most ${MAX_SUBSCRIPTIONS} channels/patterns per stream.`);
    for (const p of body.patterns) checkGlob(p);
    const t = ctx.pubsubTickets.issue(scope.session.idHash, scope.db.id, { channels: body.channels, patterns: body.patterns });
    return { id: t.id, expiresAt: new Date(t.expiresAt).toISOString() };
  });

  // Step 2: EventSource connects with the id only.
  app.get('/api/v1/databases/:db/pubsub/stream', async (req, reply) => {
    const scope = dbScope(ctx, req);
    const { sub } = parse(zStreamQuery, req.query);
    const params = ctx.pubsubTickets.take(sub, scope.session.idHash, scope.db.id);
    if (!params) throw new HttpError('not_found', 'Unknown, used or expired subscription; create a new one (POST /pubsub/subscriptions).');
    const q = { channel: params.channels, pattern: params.patterns };
    const conn = await scope.conn();
    // Take the stream slot before opening a Redis connection (over-limit bursts cost nothing).
    const reserved = reserveSse(ctx, req, 'pubsub');
    let client: DedicatedClient;
    try {
      // Aborted when the client goes away during the Redis handshake.
      client = await conn.dedicated();
    } catch (e) {
      reserved();
      if (clientIsGone(req, reply)) return reply.hijack();
      throw toHttpError(e);
    }
    // Gone while the handshake completed: keep nothing open for it (review v0.2 r4 M3).
    if (clientIsGone(req, reply)) {
      reserved();
      client.destroy();
      return reply.hijack();
    }
    const detail = `${q.channel.length} channel(s), ${q.pattern.length} pattern(s)`;
    let sse;
    try {
      sse = openSse(ctx, req, reply, { maxMs: PUBSUB_MAX_MS, kind: 'pubsub', reserved });
    } catch (e) {
      reserved();
      void client.destroy();
      throw e;
    }
    client.onError((e) => { const he = toHttpError(e); sse.send({ code: he.code, message: he.message }, 'error'); sse.close('Redis stream closed'); });
    let windowStart = Date.now(), inWindow = 0, dropped = 0;
    const emit = (channel: string, message: Buffer, totalBytes: number, pattern?: string) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        if (dropped) sse.send({ dropped }, 'dropped');
        windowStart = now;
        inWindow = 0;
        dropped = 0;
      }
      if (++inWindow > MAX_EVENTS_PER_SECOND) {
        dropped++;
        return;
      }
      const cut = totalBytes > PUBSUB_MESSAGE_PREVIEW_BYTES || message.length > PUBSUB_MESSAGE_PREVIEW_BYTES;
      const ev: PubSubMessage = { t: now, channel, message: binFromBytes(cut ? message.subarray(0, PUBSUB_MESSAGE_PREVIEW_BYTES) : message) };
      if (cut) {
        ev.truncated = true;
        ev.totalBytes = Math.max(totalBytes, message.length);
      }
      if (pattern) ev.pattern = pattern;
      if (!sse.send(ev)) dropped++;
    };
    sse.onClose(() => {
      void client.destroy();
      audit(ctx, req, { action: 'pubsub.stop', outcome: 'allowed', databaseId: scope.db.id, detail });
    });
    try {
      if (q.channel.length) await client.subscribe(q.channel, (msg, ch, total) => emit(ch.toString('utf8'), msg, total), true);
      for (const p of q.pattern) await client.pSubscribe(p, (msg, ch, total) => emit(ch.toString('utf8'), msg, total, p), true);
      audit(ctx, req, { action: 'pubsub.start', outcome: 'allowed', databaseId: scope.db.id, detail });
      sse.send({ subscribed: { channels: q.channel, patterns: q.pattern } }, 'ready');
    } catch (e) {
      sse.send({ message: toHttpError(e).message }, 'error');
      sse.close('subscribe failed');
    }
  });

  app.post('/api/v1/databases/:db/pubsub/publish', async (req): Promise<PublishResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'publish', 10, 20);
    const body = parse(zPublish, req.body);
    const base = { action: 'pubsub.publish', databaseId: scope.db.id, command: 'PUBLISH', argvRedacted: ['PUBLISH', `<${Buffer.byteLength(body.channel)} bytes>`, '<message>'] };
    try {
      const c = classify(['PUBLISH'], undefined);
      authorize(c, scope);
      const msg = body.message.enc === 'utf8' ? Buffer.from(body.message.data, 'utf8') : Buffer.from(body.message.data, 'base64');
      // The channel is a name the user typed (shown in full, like a key); the message is a value.
      const preview = buildPreview([previewCommand(['PUBLISH', body.channel, msg], 1, [1])]);
      const spec = confirmationFor(c.confirm, true, scope.db, policy.prodRequiresReason, `Publish to ${body.channel} on ${scope.db.name}`, preview);
      const { reason } = confirmOrThrow(ctx, req, scope, 'publish', req.body, body.confirmation, spec, base);
      const conn = await scope.conn();
      const receivers = asNum(await run(conn, ['PUBLISH', body.channel, msg]));
      audit(ctx, req, { ...base, outcome: 'allowed', reason });
      return { receivers };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  app.get('/api/v1/databases/:db/profiler/stream', async (req, reply) => {
    const scope = dbScope(ctx, req);
    const q = parse(zProfilerQuery, req.query);
    const base = { action: 'profiler.start', databaseId: scope.db.id, command: 'MONITOR', argvRedacted: ['MONITOR'] };
    let client: DedicatedClient;
    let reserved: (() => void) | undefined;
    try {
      // Same predicate as DatabaseSummary.features.profiler, so the UI and the enforcement cannot drift apart.
      if (!profilerAllowed(ctx, scope.db.environment, scope.role)) {
        throw new HttpError(
          'forbidden',
          scope.role !== 'admin' ? 'The profiler requires the admin role on this database.' : `The profiler is disabled for ${scope.db.environment} databases.`,
        );
      }
      const conn = await scope.conn();
      reserved = reserveSse(ctx, req, 'profiler');
      // Aborted when the client goes away during the Redis handshake.
      client = await conn.dedicated().catch((e: unknown) => {
        throw toHttpError(e);
      });
    } catch (e) {
      reserved?.();
      auditDenied(ctx, req, base, e);
    }
    // Gone while the handshake completed: keep nothing open for it (review v0.2 r4 M3).
    if (clientIsGone(req, reply)) {
      reserved!();
      client.destroy();
      audit(ctx, req, { ...base, outcome: 'error', detail: failureDetail('unavailable', 'client went away before the profiler started') });
      return reply.hijack();
    }
    let sse;
    try {
      sse = openSse(ctx, req, reply, { maxMs: q.seconds * 1000, kind: 'profiler', reserved: reserved! });
    } catch (e) {
      reserved!();
      void client.destroy();
      throw e;
    }
    client.onError((e) => { const he = toHttpError(e); sse.send({ code: he.code, message: he.message }, 'error'); sse.close('Redis stream closed'); });
    let windowStart = Date.now(), inWindow = 0, dropped = 0;
    sse.onClose(() => {
      void client.destroy();
      audit(ctx, req, { action: 'profiler.stop', outcome: 'allowed', databaseId: scope.db.id });
    });
    try {
      // A line longer than the socket keeps arrives cut (a large monitored argument never ends the profiler).
      await client.monitor((line: string, cut: boolean) => {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          if (dropped) sse.send({ dropped }, 'dropped');
          windowStart = now;
          inWindow = 0;
          dropped = 0;
        }
        if (++inWindow > MAX_EVENTS_PER_SECOND) {
          dropped++;
          return;
        }
        const ev = parseMonitorLine(String(line), cut);
        if (ev && !sse.send(ev)) dropped++;
      });
      audit(ctx, req, { ...base, outcome: 'allowed', detail: `${q.seconds}s` });
      sse.send({ seconds: q.seconds }, 'ready');
    } catch (e) {
      const he = toHttpError(e);
      audit(ctx, req, { ...base, outcome: 'error', detail: failureDetail(he.code, he.message) });
      sse.send({ message: toHttpError(e).message }, 'error');
      sse.close('monitor failed');
    }
  });
}
