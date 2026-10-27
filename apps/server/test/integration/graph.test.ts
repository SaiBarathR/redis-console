/** FalkorDB sandbox only. Fixtures are scoped to this run and removed; no shared Redis is modified. */
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { portOpen, startApp, testConfig, userSession, utf8, type Client, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';
import { graphQueryRefusal } from '@rconsole/shared';

const up = await portOpen(6413);
if (process.env.CI && !up) throw new Error("CI requires the FalkorDB sandbox on port 6413.");
const P = `graph:20261027:integration:${randomBytes(4).toString('hex')}:`;
const k = `${P}people`;
const endpoint = (db = 'graph') => `/api/v1/databases/${db}/cli`;
function config() {
  const cfg = testConfig();
  const base = { ...cfg.databases[0]!, url: 'redis://127.0.0.1:6413' };
  cfg.databases = [
    { ...base, id: 'graph', name: 'Graph' },
    { ...base, id: 'graph-ro', name: 'Graph read-only', readOnly: true },
    { ...base, id: 'graph-prod', name: 'Graph prod', environment: 'prod' },
    { ...base, id: 'graph-max', name: 'Graph max viewer', maxRole: 'viewer' },
  ];
  return cfg;
}
function direct(role: 'default' | 'viewer' | 'operator' | 'admin') {
  const c = createClient({ url: 'redis://127.0.0.1:6413', username: role === 'default' ? 'default' : `rc-${role}`, password: process.env[`SANDBOX_REDIS_${role.toUpperCase()}_PASSWORD`]!, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  c.on('error', () => {}); return c;
}

describe.skipIf(!up)('v0.4 FalkorDB security and measured execution', () => {
  let t: TestApp;
  let fixture: ReturnType<typeof direct>;
  let clients: Record<'viewer' | 'operator' | 'admin', Client>;
  beforeAll(async () => {
    fixture = direct('default'); await fixture.connect();
    await fixture.sendCommand(['GRAPH.QUERY', k, "UNWIND range(0,299) AS i CREATE (:Person {id:i, name:'sandbox'})"]);
    await fixture.sendCommand(['GRAPH.QUERY', k, 'MATCH (a:Person),(b:Person) WHERE b.id = a.id + 1 CREATE (a)-[:NEXT {weight:1}]->(b)']);
    t = await startApp(config());
  });
  beforeEach(async () => {
    clients = { viewer: await userSession(t, 'viewer'), operator: await userSession(t, 'operator'), admin: await userSession(t, 'admin') };
  });
  afterAll(async () => {
    if (fixture?.isOpen) {
      for await (const batch of fixture.scanIterator({ MATCH: `${P}*`, COUNT: 100 })) if (batch.length) await fixture.del(batch);
      await fixture.close();
    }
    await t?.close();
  });
  it('keeps both read and write time bounds, row bounds and queue bounds in module config', async () => {
    for (const [name, value] of [['TIMEOUT_DEFAULT', 1000], ['TIMEOUT_MAX', 1000], ['RESULTSET_SIZE', 10000], ['MAX_QUEUED_QUERIES', 25]] as const) expect(await fixture.sendCommand(['GRAPH.CONFIG', 'GET', name])).toEqual([name, value]);
  });
  it.each(['viewer', 'operator', 'admin'] as const)('%s reads verbose node/edge replies and plans on its own ACL tier', async (role) => {
    const c = clients[role];
    for (const argv of [['GRAPH.RO_QUERY', k, 'MATCH (a)-[r]->(b) RETURN a,r,b LIMIT 3'], ['GRAPH.EXPLAIN', k, 'MATCH (n) RETURN n'], ['GRAPH.LIST'], ['GRAPH.INFO', 'ObjectPool'], ['GRAPH.MEMORY', 'USAGE', k]]) {
      const res = await c.req('POST', endpoint(), { argv });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.reply.t, JSON.stringify(res.json)).not.toBe('err');
    }
    const who = await c.req('POST', endpoint(), { argv: ['CLIENT', 'INFO'] });
    expect(who.json.reply.v.data).toContain(`user=rc-${role}`);
    const read = await c.req('POST', '/api/v1/databases/graph/key/read', { key: utf8(k) });
    expect(read.json.type).toBe('graphdata');
    expect(read.json.value.message).toMatch(/GRAPH.RO_QUERY.*Workbench/);
  });
  it('viewer, readOnly and maxRole reject graph writes before confirmation', async () => {
    for (const argv of [['GRAPH.QUERY', k, 'CREATE (:Nope)'], ['GRAPH.PROFILE', k, 'MATCH (n) DELETE n'], ['GRAPH.DELETE', k]]) {
      expect((await clients.viewer.req('POST', endpoint(), { argv })).status).toBe(403);
      expect((await clients.admin.req('POST', endpoint('graph-ro'), { argv })).status).toBe(403);
      expect((await clients.admin.req('POST', endpoint('graph-max'), { argv })).status).toBe(403);
    }
  });
  it.each(['operator', 'admin'] as const)('%s must confirm QUERY and PROFILE, even when the query looks read-only', async (role) => {
    for (const cmd of ['GRAPH.QUERY', 'GRAPH.PROFILE']) {
      const { first, second } = await confirmed(clients[role], endpoint(), { argv: [cmd, k, 'MATCH (n) RETURN n.id LIMIT 2'] });
      expect(first.json.error.confirmation.level).toBe('confirm');
      expect(first.json.error.confirmation.preview.commands[0].argv.slice(-2).map((a: any) => a.v.data)).toEqual(['TIMEOUT', '1000']);
      expect(second.status).toBe(200); expect(second.json.reply.t).not.toBe('err');
    }
  });
  it('destructive Cypher changes nothing until confirmation; tokens bind exact argv; prod adds typed name and reason', async () => {
    const argv = ['GRAPH.QUERY', k, 'MATCH (n:Person) WHERE n.id = 299 DETACH DELETE n'];
    const first = await clients.operator.req('POST', endpoint(), { argv });
    expect(first.status).toBe(428);
    const count = async () => (await fixture.sendCommand(['GRAPH.RO_QUERY', k, 'MATCH (n) RETURN count(n)']) as any)[1][0][0];
    expect(await count()).toBe(300);
    const swapped = await clients.operator.req('POST', endpoint(), { argv: ['GRAPH.QUERY', k, 'MATCH (n) DETACH DELETE n'], confirmation: { token: first.json.error.confirmation.token } });
    expect(swapped.status).toBe(428); expect(await count()).toBe(300);
    const done = (await confirmed(clients.operator, endpoint(), { argv })).second;
    expect(done.status).toBe(200); expect(await count()).toBe(299);
    const prod = await clients.operator.req('POST', endpoint('graph-prod'), { argv: ['GRAPH.QUERY', k, 'RETURN 1'] });
    expect(prod.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'Graph prod', reasonRequired: true });
  });
  it('only admin deletes an entire graph, with typed confirmation', async () => {
    const key = `${P}delete`;
    await fixture.sendCommand(['GRAPH.QUERY', key, 'CREATE (:P)']);
    expect((await clients.operator.req('POST', endpoint(), { argv: ['GRAPH.DELETE', key] })).status).toBe(403);
    const { first, second } = await confirmed(clients.admin, endpoint(), { argv: ['GRAPH.DELETE', key] });
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'Graph' });
    expect(second.status).toBe(200); expect(await fixture.exists(key)).toBe(0);
  });
  it('refuses LOAD CSV, UDF, internal commands and CONFIG SET for every role, binary argv and Workbench included', async () => {
    const blocked = [
      ['GRAPH.RO_QUERY', k, "LOAD/*gap*/CSV FROM 'https://example.invalid/a.csv' AS row RETURN row"],
      ['GRAPH.EXPLAIN', k, "LOAD CSV FROM 'file://a.csv' AS row RETURN row"],
      ['GRAPH.QUERY', k, 'CALL db.idx.fulltext.createNodeIndex("P","name")'],
      ['GRAPH.RO_QUERY', k, 'RETURN Library.fn()'],
      ['GRAPH.SLOWLOG', k, 'RESET'], ['GRAPH.MEMORY', 'PURGE', k],
      ['GRAPH.UDF', 'LOAD', 'library', 'secret canary udf source'], ['GRAPH.CONFIG', 'SET', 'TIMEOUT_MAX', '0'],
      ['GRAPH.BULK', k, 'binary'], ['GRAPH.RESTORE', k, 'binary'], ['GRAPH.DEBUG'], ['GRAPH.EFFECT'], ['GRAPH.RECORD'], ['GRAPH.COPY', k, `${P}copy`], ['GRAPH.CONSTRAINT', k, 'CREATE'], ['GRAPH.INFO'],
    ];
    for (const c of Object.values(clients)) for (const argv of blocked) {
      const res = await c.req('POST', endpoint(), { argvBin: argv.map((x) => ({ enc: 'base64', data: Buffer.from(x).toString('base64') })) });
      expect(res.status, JSON.stringify(res.json)).toBe(403);
    }
    const w = await clients.admin.req('POST', '/api/v1/databases/graph/workbench', { script: `GRAPH.CONFIG SET TIMEOUT_MAX 0\nGRAPH.RO_QUERY ${k} "LOAD CSV FROM 'file://a.csv' AS r RETURN r"` });
    expect(w.status).toBe(200); expect(w.json.results.every((r: any) => r.error?.code === 'command_blocked')).toBe(true);
    const audit = JSON.stringify(t.ctx.audit.query({ limit: 500 }).events) + t.auditLines.join('\n');
    expect(audit).not.toContain('secret canary udf source');
    expect(audit).not.toContain(k);
    expect(audit).toContain('denied');
  });
  it('allows only reviewed metadata procedures; RO_QUERY refuses Cypher mutations in FalkorDB too', async () => {
    for (const proc of ['labels', 'relationshipTypes', 'propertyKeys']) {
      const r = await clients.viewer.req('POST', endpoint(), { argv: ['GRAPH.RO_QUERY', k, `CALL db.${proc}()`] });
      expect(r.status).toBe(200); expect(r.json.reply.t).not.toBe('err');
    }
    const absent = `${P}explain-absent`;
    await clients.viewer.req('POST', endpoint(), { argv: ['GRAPH.EXPLAIN', absent, 'CREATE (:Nope)'] });
    expect(await fixture.exists(absent)).toBe(0);
    const res = await clients.viewer.req('POST', endpoint(), { argv: ['GRAPH.RO_QUERY', k, 'CREATE (:Nope)'] });
    expect(res.status).toBe(200); expect(res.json.reply.t).toBe('err');
  });
  it('admin CONFIG GET and SLOWLOG work on readOnly; other roles cannot read query logs or config', async () => {
    for (const argv of [['GRAPH.CONFIG', 'GET', 'TIMEOUT_MAX'], ['GRAPH.SLOWLOG', k]]) {
      for (const c of [clients.viewer, clients.operator]) expect((await c.req('POST', endpoint(), { argv })).status).toBe(403);
      const res = await clients.admin.req('POST', endpoint('graph-ro'), { argv });
      expect(res.status).toBe(200); expect(res.json.reply.t).not.toBe('err');
    }
  });
  it('enforces Redis ACLs underneath policy (including first-argument GET-only CONFIG)', async () => {
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const r = direct(role); await r.connect();
      try {
        for (const argv of [['GRAPH.UDF', 'LIST'], ['GRAPH.CONFIG', 'SET', 'TIMEOUT_MAX', '0'], ['GRAPH.BULK', k, 'x']]) await expect(r.sendCommand(argv)).rejects.toThrow(/NOPERM/);
        if (role === 'viewer') await expect(r.sendCommand(['GRAPH.QUERY', k, 'RETURN 1'])).rejects.toThrow(/NOPERM/);
        if (role !== 'admin') await expect(r.sendCommand(['GRAPH.DELETE', k])).rejects.toThrow(/NOPERM/);
      } finally { await r.close(); }
    }
  });
  it('bounds both read and write computation in the engine; connection recovers after a timeout', async () => {
    for (const cmd of ['GRAPH.RO_QUERY', 'GRAPH.QUERY', 'GRAPH.PROFILE']) {
      const query = cmd === 'GRAPH.RO_QUERY'
        ? 'UNWIND range(0,1000000) AS a UNWIND range(0,1000000) AS b RETURN sum(a*b)'
        : 'UNWIND range(0,1000000) AS a UNWIND range(0,1000000) AS b WITH sum(a*b) AS total CREATE (:TimeoutProbe {total:total})';
      const start = performance.now();
      const body = { argv: [cmd, k, query, 'TIMEOUT', '1'] };
      const res = cmd === 'GRAPH.RO_QUERY' ? await clients.viewer.req('POST', endpoint(), body) : (await confirmed(clients.operator, endpoint(), body)).second;
      expect(res.status).toBe(200); expect(res.json.reply.t).toBe('err'); expect(res.json.reply.v).toMatch(/timed out/i);
      expect(performance.now() - start).toBeLessThan(3000);
    }
    expect((await clients.viewer.req('POST', endpoint(), { argv: ['PING'] })).json.reply.v.data).toBe('PONG');
  });
  it('blocks preloaded UDF calls with backtick/backslash/comment quoting (live lexer regression)', async () => {
    const lib = `${P}udf${String.fromCharCode(92)}`;
    const query = 'RETURN `' + lib + '`.f() //`';
    await fixture.sendCommand(['GRAPH.UDF', 'LOAD', lib, 'function rcProbe(){return 7;} falkor.register("f",rcProbe);']);
    try {
      const direct = await fixture.sendCommand(['GRAPH.RO_QUERY', k, query]) as any;
      expect(direct[1][0][0]).toBe(7); // Proves valid Cypher and real preloaded-code execution, not just a syntax error.
      for (const c of Object.values(clients)) for (const command of ['GRAPH.RO_QUERY', 'GRAPH.QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']) {
        const res = await c.req('POST', endpoint(), { argv: [command, k, query] });
        expect(res.status, JSON.stringify(res.json)).toBe(403);
        expect(res.json.error.code).toBe('command_blocked');
      }
    } finally { await fixture.sendCommand(['GRAPH.UDF', 'DELETE', lib]); }
  });
  it('the guard refuses whatever FalkorDB reads as LOAD CSV, a procedure call or a namespaced call (differential, review v0.4 r2 graph H1)', async () => {
    // Tokenisation probes around three payloads; FalkorDB plans each with EXPLAIN (nothing runs). Where the engine sees
    // the payload as code (a Load CSV or ProcedureCall operation, or a function it looks up), the guard must refuse.
    const fragments = ['', ' ', '//x\r', '//x\n', '//x\r\n', '/*x*/', '/*\r*/', '`', "'", '"', '\\', '\r', '\n', '\r\n', '//`\n', '//x\r`\n', '\n//`', '`a`', "'a'", '``', '/*`*/', '//\r\r\n'];
    const payloads = ["LOAD CSV FROM 'file:///nonexistent.csv' AS row RETURN row", 'CALL db.idx.fulltext.queryNodes(\'x\', \'y\') YIELD node RETURN node', 'RETURN rcprobe.fn(1) AS b'];
    let engineSawCode = 0;
    let checked = 0;
    for (const payload of payloads) for (const pre of fragments) for (const post of fragments) {
      const query = `${pre}${payload}${post}`;
      let text: string;
      try { text = JSON.stringify(await fixture.sendCommand(['GRAPH.EXPLAIN', k, query])); } catch (e) { text = String((e as Error).message); }
      const code = /Load CSV|ProcedureCall|rcprobe\.fn|queryNodes/i.test(text) && !/syntax|Invalid input|errMsg/i.test(text);
      checked++;
      if (!code) continue;
      engineSawCode++;
      expect(graphQueryRefusal(query), `engine read ${JSON.stringify(query)} as code: ${text.slice(0, 120)}`).toBeDefined();
    }
    expect(checked).toBe(payloads.length * fragments.length ** 2);
    expect(engineSawCode).toBeGreaterThan(100);
  }, 120_000);

  it('caps result production to 10k rows and the measured wire independently of UI display bounds', async () => {
    const rows = await fixture.sendCommand(['GRAPH.RO_QUERY', k, 'UNWIND range(0,10004) AS i RETURN i']) as any;
    expect(rows[1].length).toBe(10000);
    const cfg = config(); cfg.policy.maxReadReplyBytes = 2048;
    const small = await startApp(cfg);
    try {
      const c = await userSession(small, 'viewer');
      const res = await c.req('POST', endpoint(), { argv: ['GRAPH.RO_QUERY', k, 'MATCH (n) RETURN n'] });
      expect(res.status).toBe(413);
      expect((await c.req('POST', endpoint(), { argv: ['GRAPH.RO_QUERY', k, 'RETURN 1'] })).status).toBe(200);
    } finally { await small.close(); }
  });
});
