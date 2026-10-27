/**
 * v0.4 arrays: read routes of the array inspector (POST bodies; no side effects, no confirmation). Each request is
 * one audited data read (`auditedRead`: one event, counts only, at most four data reads per user at once) with its
 * own per-user rate limit. Writes are typed ops on `POST /ops` (`array.set`, `array.insert`, `array.delete`,
 * `array.delete-range`), planned in redis/array.ts.
 */
import type { FastifyInstance } from 'fastify';
import {
  ARRAY_SEARCH_MAX_BYTES,
  zArrayAggregate,
  zArrayRange,
  zArraySearch,
  type ArrayAggregateResult,
  type ArrayPage,
  type ArraySearchResult,
} from '@rconsole/shared';
import { dbScope, parse, rateLimit, type AppContext } from '../context.ts';
import { keyTag } from '../audit.ts';
import { auditedRead } from '../policy/enforce.ts';
import { aggregateArray, predicateBytes, readArrayPage, requireArray, searchArray } from '../redis/array.ts';
import { PageBudget, READ_BODY_LIMIT, keyBytes } from './keys.ts';

/** Audit detail for a page of elements: counts only. */
const pageDetail = (items: { truncated?: true }[], extra: string[] = []) =>
  [`returned=${items.length}`, ...extra, ...(items.some((i) => i.truncated) ? ['truncated'] : [])].join(' ');

export function registerArrayRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  app.post('/api/v1/databases/:db/array/range', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<ArrayPage> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'array-range', 20, 40);
    const q = parse(zArrayRange, req.body);
    const key = keyBytes(q.key);
    const base = { action: 'array.range', databaseId: scope.db.id, command: 'ARSCAN', argvRedacted: ['ARSCAN', keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const budget = new PageBudget(policy.maxReplyBytes);
      const conn = await scope.conn();
      await requireArray(scope, conn, key, policy.commandTimeoutMs);
      return readArrayPage(scope, conn, key, q, (x) => budget.preview(x), policy.commandTimeoutMs);
    }, (r) => pageDetail(r.items, r.next ? ['more'] : []));
  });

  app.post('/api/v1/databases/:db/array/search', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<ArraySearchResult> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'array-search', 5, 10);
    const q = parse(zArraySearch, req.body);
    const key = keyBytes(q.key);
    // Predicate kinds are fixed words; their values are data (sizes only).
    const predicates = q.predicates.flatMap((p) => [p.kind.toUpperCase(), `<${predicateBytes(p.value, p.kind).length} bytes>`]);
    const base = { action: 'array.search', databaseId: scope.db.id, command: 'ARSCAN', argvRedacted: ['ARSCAN', keyTag(key), ...predicates, q.combine.toUpperCase(), ...(q.nocase ? ['NOCASE'] : [])], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const budget = new PageBudget(policy.maxReplyBytes);
      const conn = await scope.conn();
      await requireArray(scope, conn, key, policy.commandTimeoutMs);
      // Values read from one budget of at most ARRAY_SEARCH_MAX_BYTES (and the request read budget), each read within the
      // per-reply cap (review v0.4 r2 H2).
      const maxBytes = Math.min(ARRAY_SEARCH_MAX_BYTES, policy.maxReadReplyBytes);
      return searchArray(scope, conn, key, q, (x) => budget.preview(x), policy.commandTimeoutMs, { maxBytes, readCap: policy.maxReadReplyBytes });
    }, (r) => pageDetail(r.items as { truncated?: true }[], [`elements=${r.elements}`, ...(r.next ? ['more'] : [])]));
  });

  app.post('/api/v1/databases/:db/array/aggregate', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<ArrayAggregateResult> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'array-aggregate', 5, 10);
    const q = parse(zArrayAggregate, req.body);
    const key = keyBytes(q.key);
    const base = { action: 'array.aggregate', databaseId: scope.db.id, command: 'AROP', argvRedacted: ['AROP', keyTag(key), q.op.toUpperCase()], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      await requireArray(scope, conn, key, policy.commandTimeoutMs);
      return aggregateArray(scope, conn, key, q, policy.commandTimeoutMs);
    },
      (r) => `op=${r.op} elements=${r.elements}${r.result === null ? ' empty' : ''}`);
  });
}
