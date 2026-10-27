/**
 * Vector-set inspector reads (v0.4, F23). All POST (member names and filters are data), all through `detailRead`
 * (fixed read policy, the caller's ACL tier, the measured transport with a per-reply cap and the request's wire
 * budget) and audited once per request with counts only. Writes are the `vset.*` typed ops of POST /ops.
 */
import type { FastifyInstance } from 'fastify';
import { ErrorReply } from 'redis';
import {
  VSET_ATTR_PREVIEW_BYTES,
  VSET_EMBED_MAX_DIM,
  VSET_EMBED_PREVIEW_VALUES,
  VSET_MEMBER_MAX_BYTES,
  binFromBytes,
  zVsetAttributesRequest,
  zVsetElementRequest,
  zVsetMembersRequest,
  zVsetSearchRequest,
  type KeyValue,
  type VsetAttributeCell,
  type VsetAttributesResponse,
  type VsetElementResponse,
  type VsetMembersResponse,
  type VsetSearchResponse,
} from '@rconsole/shared';
import { dbScope, parse, rateLimit, type AppContext, type DbScope } from '../context.ts';
import { keyTag } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { authorize, fixedCommand } from '../policy/policy.ts';
import { auditedRead, type AuditBase } from '../policy/enforce.ts';
import { toHttpError } from '../redis/exec.ts';
import type { Arg, Conn, SendOpts } from '../redis/manager.ts';
import { asNum, asStr } from '../redis/reply.ts';
import {
  TM_VSET,
  VSET_ATTR_ROW_READ_BYTES,
  VSET_ATTR_TOO_LARGE_RETRIES,
  VSET_INFO_REPLY_BYTES,
  VSET_LINKS_REPLY_BYTES,
  infoOf,
  isTrue,
  linksOf,
  memberBytes,
  pageOf,
  similarOf,
  vrangeArgs,
  vsetRequestError,
  vsimArgs,
} from '../redis/vectorset.ts';
import { detailRead } from './keyDetail.ts';
import { keyBytes, READ_BODY_LIMIT } from './keys.ts';

/** Body limits: the attributes request carries up to VSET_ATTR_ROWS_MAX member names; a search may carry a vector. */
export const VSET_ATTR_BODY_LIMIT = 2 * 1024 * 1024;
export const VSET_SEARCH_BODY_LIMIT = 1024 * 1024;

const TYPE_ONLY = 'This key is not a vector set.';

/** Too-large replies are a result here (the transport has already dropped that socket), not a failed request. */
const tooLarge = (e: unknown) => e instanceof HttpError && e.code === 'too_large';

/** VCARD, VDIM, VINFO and the first page: the `vectorset` case of `key/read`. */
export async function readVectorSet(scope: DbScope, conn: Conn, key: Buffer, o: { timeout: number; count: number; budget: number; replyBudget: { remaining: number } }): Promise<{ value: Extract<KeyValue, { type: 'vectorset' }>; length: number }> {
  const small: SendOpts = { key, timeout: o.timeout, typeMapping: TM_VSET, maxBytes: VSET_INFO_REPLY_BYTES, replyBudget: o.replyBudget };
  const [card, dim, vinfo] = await Promise.all([
    detailRead(scope, conn, ['VCARD', key], small),
    detailRead(scope, conn, ['VDIM', key], small),
    detailRead(scope, conn, ['VINFO', key], small),
  ]);
  const raw = await detailRead<unknown[]>(scope, conn, vrangeArgs(key, { count: o.count })!, { key, timeout: o.timeout, typeMapping: TM_VSET, replyBudget: o.replyBudget });
  const info = infoOf(card, dim, vinfo);
  return { value: { type: 'vectorset', info, page: pageOf(raw, o.count, o.budget) }, length: info.size };
}

/** The key must be a vector set (TYPE first, so another type is a clear 400 rather than a WRONGTYPE). */
async function requireVectorSet(scope: DbScope, conn: Conn, key: Buffer, timeout: number): Promise<void> {
  const type = asStr(await detailRead(scope, conn, ['TYPE', key], { key, timeout, maxBytes: 4096 }));
  if (type === 'none') throw new HttpError('not_found', 'Key does not exist.');
  if (type !== 'vectorset') throw new HttpError('validation', TYPE_ONLY);
}

/** A row's attribute cell from VGETATTR's reply: null, or a preview cut at VSET_ATTR_PREVIEW_BYTES. */
function cellOf(v: unknown): VsetAttributeCell {
  if (v === null || v === undefined) return null;
  const b = Buffer.isBuffer(v) ? v : Buffer.from(asStr(v));
  return b.length > VSET_ATTR_PREVIEW_BYTES
    ? { value: binFromBytes(b.subarray(0, VSET_ATTR_PREVIEW_BYTES)), truncated: true, totalBytes: b.length }
    : { value: binFromBytes(b) };
}

export function registerVectorSetRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  /** One page of members (VRANGE), after a member and/or within a byte prefix. */
  app.post('/api/v1/databases/:db/vectorset/members', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<VsetMembersResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'vset-members', 10, 20);
    const q = parse(zVsetMembersRequest, req.body);
    const key = keyBytes(q.key);
    const after = q.after ? memberBytes(q.after, 'after') : undefined;
    const prefix = q.prefix ? memberBytes(q.prefix, 'prefix') : undefined;
    const base: AuditBase = { action: 'vset.members', databaseId: scope.db.id, command: 'VRANGE', argvRedacted: ['VRANGE', keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const replyBudget = { remaining: policy.maxReadReplyBytes };
      await requireVectorSet(scope, conn, key, policy.commandTimeoutMs);
      const total = asNum(await detailRead(scope, conn, ['VCARD', key], { key, timeout: policy.commandTimeoutMs, maxBytes: VSET_INFO_REPLY_BYTES }));
      const args = vrangeArgs(key, { after, prefix, count: q.count });
      const raw = args ? await detailRead<unknown[]>(scope, conn, args, { key, timeout: policy.commandTimeoutMs, typeMapping: TM_VSET, replyBudget }) : [];
      return { page: pageOf(raw, q.count, policy.maxReplyBytes, prefix), total };
    }, (r) => `returned=${r.page.members.length} total=${r.total}${r.page.prefix ? ' prefix' : ''}${r.page.next ? ' more' : ''}`);
  });

  /**
   * VGETATTR of the rows on screen, pipelined on one measured socket (one round trip), each reply capped at
   * VSET_ATTR_ROW_READ_BYTES. A reply over the cap fails the batch; the rows are then read one at a time, and after
   * VSET_ATTR_TOO_LARGE_RETRIES too-large rows the remaining ones are reported too large without another read.
   */
  app.post('/api/v1/databases/:db/vectorset/attributes', { bodyLimit: VSET_ATTR_BODY_LIMIT }, async (req): Promise<VsetAttributesResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'vset-attributes', 10, 30);
    const q = parse(zVsetAttributesRequest, req.body);
    const key = keyBytes(q.key);
    const members = q.members.map((m) => memberBytes(m));
    const base: AuditBase = { action: 'vset.attributes', databaseId: scope.db.id, command: 'VGETATTR', argvRedacted: ['VGETATTR', keyTag(key), `<${members.length} members>`], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const release = ctx.slots.acquire(`vset-attributes:${scope.session.userId}`, 2);
      if (!release) throw new HttpError('rate_limited', 'At most two attribute reads can run at once per user.');
      try {
        authorize(fixedCommand('VGETATTR', 'read'), scope);
        const conn = await scope.conn();
        const replyBudget = { remaining: policy.maxReadReplyBytes };
        const o = { typeMapping: TM_VSET, timeout: policy.commandTimeoutMs, maxBytes: VSET_ATTR_ROW_READ_BYTES, replyBudget };
        let replies: unknown[] | undefined;
        try {
          replies = await conn.pipeline(members.map((m) => ({ args: ['VGETATTR', key, m] as Arg[], key })), o);
        } catch (e) {
          if (!tooLarge(e)) throw toHttpError(e);
        }
        if (replies) {
          const denied = replies.find((r) => r instanceof ErrorReply);
          if (denied) throw toHttpError(denied);
          return { attributes: replies.map(cellOf) };
        }
        const attributes: VsetAttributeCell[] = [];
        let failures = 0;
        for (const m of members) {
          if (failures >= VSET_ATTR_TOO_LARGE_RETRIES) { attributes.push({ tooLarge: true }); continue; }
          try {
            attributes.push(cellOf(await detailRead(scope, conn, ['VGETATTR', key, m], { key, ...o, replyBudget: undefined })));
          } catch (e) {
            if (!tooLarge(e)) throw e;
            failures++;
            attributes.push({ tooLarge: true });
          }
        }
        return { attributes };
      } finally { release(); }
    }, (r) => `rows=${r.attributes.length} present=${r.attributes.filter((a) => a !== null).length} tooLarge=${r.attributes.filter((a) => a !== null && 'tooLarge' in a).length}`);
  });

  /** One member: attributes (up to maxValueBytes), embedding (bounded), neighbours per layer (bounded). */
  app.post('/api/v1/databases/:db/vectorset/element', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<VsetElementResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'vset-element', 10, 20);
    const q = parse(zVsetElementRequest, req.body);
    const key = keyBytes(q.key);
    const member = memberBytes(q.member);
    const base: AuditBase = { action: 'vset.element', databaseId: scope.db.id, command: 'VEMB', argvRedacted: ['VEMB', keyTag(key), `<${member.length} bytes>`], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const t = policy.commandTimeoutMs;
      const replyBudget = { remaining: policy.maxReadReplyBytes };
      await requireVectorSet(scope, conn, key, t);
      if (!isTrue(await detailRead(scope, conn, ['VISMEMBER', key, member], { key, timeout: t, maxBytes: 4096 }))) throw new HttpError('not_found', 'This member does not exist in the vector set.');
      const [dimRaw, vinfo] = await Promise.all([
        detailRead(scope, conn, ['VDIM', key], { key, timeout: t, maxBytes: VSET_INFO_REPLY_BYTES }),
        detailRead(scope, conn, ['VINFO', key], { key, timeout: t, typeMapping: TM_VSET, maxBytes: VSET_INFO_REPLY_BYTES }),
      ]);
      const dim = asNum(dimRaw);
      const out: VsetElementResponse = { member: binFromBytes(member), attributes: null, embedding: { values: [], dim, truncated: false } };
      const quant = infoOf(0, dim, vinfo).quantization;
      if (quant) out.quantization = quant;
      try {
        const attr = await detailRead(scope, conn, ['VGETATTR', key, member], { key, timeout: t, typeMapping: TM_VSET, maxBytes: Math.min(policy.maxReadReplyBytes, policy.maxValueBytes + 64), replyBudget });
        if (attr !== null && attr !== undefined) out.attributes = binFromBytes(Buffer.isBuffer(attr) ? attr : Buffer.from(asStr(attr)));
      } catch (e) {
        if (!tooLarge(e)) throw e;
        out.attributesTooLarge = true;
      }
      if (dim > VSET_EMBED_MAX_DIM) out.embedding.skipped = true;
      else {
        // A RESP3 double is at most about 30 bytes on the wire; the cap follows the set's dimension.
        const values = await detailRead<unknown[]>(scope, conn, ['VEMB', key, member], { key, timeout: t, typeMapping: TM_VSET, maxBytes: Math.min(policy.maxReadReplyBytes, dim * 40 + 1024), replyBudget })
          .catch((e: unknown) => { throw vsetRequestError(e) ?? e; });
        const list = Array.isArray(values) ? values : [];
        out.embedding = { values: list.slice(0, VSET_EMBED_PREVIEW_VALUES).map(asStr), dim, truncated: list.length > VSET_EMBED_PREVIEW_VALUES };
      }
      if (q.links) {
        try {
          Object.assign(out, linksOf(await detailRead(scope, conn, ['VLINKS', key, member, 'WITHSCORES'], { key, timeout: t, typeMapping: TM_VSET, maxBytes: Math.min(policy.maxReadReplyBytes, VSET_LINKS_REPLY_BYTES), replyBudget })));
        } catch (e) {
          if (!tooLarge(e)) throw e;
          out.linksTooLarge = true;
        }
      }
      return out;
    }, (r) => `dim=${r.embedding.dim} values=${r.embedding.values.length}${r.embedding.truncated ? ' truncated' : ''}${r.embedding.skipped ? ' skipped' : ''} attributes=${r.attributes ? 'yes' : r.attributesTooLarge ? 'too-large' : 'no'} layers=${r.links?.length ?? 0}`);
  });

  /** Similarity search (VSIM) by member or by vector, bounded in COUNT, EF, filter length and filter effort. */
  app.post('/api/v1/databases/:db/vectorset/search', { bodyLimit: VSET_SEARCH_BODY_LIMIT }, async (req): Promise<VsetSearchResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'vset-search', 5, 10);
    const q = parse(zVsetSearchRequest, req.body);
    const key = keyBytes(q.key);
    const element = 'element' in q.query ? memberBytes(q.query.element) : undefined;
    const base: AuditBase = {
      action: 'vset.search', databaseId: scope.db.id, command: 'VSIM', keyCount: 1,
      argvRedacted: ['VSIM', keyTag(key), element ? 'ELE' : 'VALUES', element ? `<${element.length} bytes>` : `<${'values' in q.query ? q.query.values.length : 0} values>`, 'COUNT', String(q.count), ...(q.filter ? ['FILTER', `<${Buffer.byteLength(q.filter)} bytes>`] : [])],
    };
    return auditedRead(ctx, req, base, async () => {
      const release = ctx.slots.acquire(`vset-search:${scope.session.userId}`, 2);
      if (!release) throw new HttpError('rate_limited', 'At most two similarity searches can run at once per user.');
      try {
        const conn = await scope.conn();
        await requireVectorSet(scope, conn, key, policy.commandTimeoutMs);
        let raw: unknown;
        try {
          raw = await detailRead(scope, conn, vsimArgs(key, q, element), { key, timeout: policy.commandTimeoutMs, typeMapping: TM_VSET, replyBudget: { remaining: policy.maxReadReplyBytes } });
        } catch (e) {
          throw vsetRequestError(e, q.filter) ?? e;
        }
        let left = policy.maxReplyBytes;
        return {
          results: similarOf(raw, q.withAttributes).map((r) => {
            const m = r.member.length > VSET_MEMBER_MAX_BYTES ? { member: binFromBytes(r.member.subarray(0, VSET_MEMBER_MAX_BYTES)), truncated: true as const } : { member: binFromBytes(r.member) };
            const out: VsetSearchResponse['results'][number] = { ...m, score: r.score };
            if (q.withAttributes) {
              // Attribute previews share the response's display budget; past it they are listed as too large.
              const cell = cellOf(r.attributes);
              const size = cell && 'value' in cell ? cell.value.data.length : 0;
              out.attributes = size > left ? { tooLarge: true } : cell;
              left -= Math.min(size, left);
            }
            return out;
          }),
        };
      } finally { release(); }
    }, (r) => `results=${r.results.length}${q.filter ? ' filtered' : ''}${q.ef ? ` ef=${q.ef}` : ''}`);
  });
}

