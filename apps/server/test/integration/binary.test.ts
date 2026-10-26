import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64, cleanupPrefix, keyPrefix, bk, sandboxAdmin, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const fromBin = (b: { enc: string; data: string }) => (b.enc === 'utf8' ? Buffer.from(b.data, 'utf8') : Buffer.from(b.data, 'base64'));

describe.skipIf(!sandboxUp)('binary safety', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('bin');
  const binKey = Buffer.concat([Buffer.from(P), Buffer.from([0xff, 0x00, 0xfe, 0x0a])]);

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('SET/GET via argvBin round-trips every byte value', async () => {
    const c = await userSession(t, 'operator');
    let res = await c.req('POST', '/api/v1/databases/e2e/cli', { argvBin: [{ enc: 'utf8', data: 'SET' }, b64(binKey), b64(allBytes)] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    res = await c.req('POST', '/api/v1/databases/e2e/cli', { argvBin: [{ enc: 'utf8', data: 'GET' }, b64(binKey)] });
    expect(res.json.reply.t).toBe('str');
    expect(res.json.reply.v.enc).toBe('base64');
    expect(fromBin(res.json.reply.v).equals(allBytes)).toBe(true);
    // Stored bytes are exact.
    const stored = await r.withTypeMapping({ 36: Buffer } as never).get(binKey as never);
    expect(Buffer.from(stored as unknown as Buffer).equals(allBytes)).toBe(true);
  });

  it('\\xHH escapes in a CLI line are raw bytes', async () => {
    const c = await userSession(t, 'operator');
    const res = await c.req('POST', '/api/v1/databases/e2e/cli', { line: `SET ${P}esc "a\\xffb\\x00"` });
    expect(res.status).toBe(200);
    const v = await r.withTypeMapping({ 36: Buffer } as never).get(`${P}esc`);
    expect(Buffer.from(v as unknown as Buffer).equals(Buffer.from([0x61, 0xff, 0x62, 0x00]))).toBe(true);
  });

  it('binary key names round-trip through /keys/scan and /key/read', async () => {
    const c = await userSession(t, 'viewer');
    const keys: Buffer[] = [];
    let cursor = '0';
    do {
      const res = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `${P}*`, count: 1000, cursor });
      expect(res.status).toBe(200);
      keys.push(...res.json.keys.map((k: any) => fromBin(k.key)));
      cursor = res.json.cursor;
    } while (cursor !== '0');
    const found = keys.find((k) => k.equals(binKey));
    expect(found).toBeDefined();
    const res = await c.req('POST', '/api/v1/databases/e2e/key/read', { key: bk(binKey) });
    expect(res.status).toBe(200);
    expect(fromBin(res.json.key).equals(binKey)).toBe(true);
    expect(res.json.value.value.enc).toBe('base64');
    expect(fromBin(res.json.value.value).equals(allBytes)).toBe(true);
  });

  it('binary hash fields survive HGETALL (map keys stay bytes)', async () => {
    await r.hSet(`${P}h`, Buffer.from([0xc3, 0x28]) as never, Buffer.from([0x80]) as never);
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', '/api/v1/databases/e2e/cli', { line: `HGETALL ${P}h` });
    expect(res.json.reply.t).toBe('map');
    const [k, v] = res.json.reply.v[0];
    expect(fromBin(k.v).equals(Buffer.from([0xc3, 0x28]))).toBe(true);
    expect(fromBin(v.v).equals(Buffer.from([0x80]))).toBe(true);
    const det = await c.req('POST', '/api/v1/databases/e2e/key/read', { key: bk(`${P}h`) });
    expect(fromBin(det.json.value.entries[0].field).equals(Buffer.from([0xc3, 0x28]))).toBe(true);
  });

  it('typed ops accept base64 keys and values', async () => {
    const c = await userSession(t, 'operator');
    const key = Buffer.concat([Buffer.from(P), Buffer.from([0x01, 0x02])]);
    const res = await c.req('POST', '/api/v1/databases/e2e/ops', { op: 'string.set', key: b64(key), value: b64(Buffer.from([0, 1, 2, 255])) });
    expect(res.status).toBe(200);
    const v = await r.withTypeMapping({ 36: Buffer } as never).get(key as never);
    expect(Buffer.from(v as unknown as Buffer).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });

  it('H3: BOM names survive scan, read, write and delete without touching the plain key', async () => {
    const c = await userSession(t, 'operator');
    const plain = `${P}bom`;
    const bom = `\ufeff${plain}`;
    try {
      await r.set(plain, 'plain');
      await r.set(bom, '\ufeffvalue');
      const scan = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `*${P}bom`, count: 1000 });
      expect(scan.status).toBe(200);
      expect(scan.json.keys.map((k: { key: unknown }) => k.key)).toEqual(expect.arrayContaining([{ enc: 'utf8', data: plain }, { enc: 'utf8', data: bom }]));
      const read = await c.req('POST', '/api/v1/databases/e2e/key/read', { key: bk(bom) });
      expect(fromBin(read.json.key).toString()).toBe(bom);
      expect(fromBin(read.json.value.value).toString()).toBe('\ufeffvalue');
      expect((await c.req('POST', '/api/v1/databases/e2e/ops', { op: 'string.set', key: bk(bom), value: bk('changed') })).status).toBe(200);
      expect(await r.get(bom)).toBe('changed');
      expect(await r.get(plain)).toBe('plain');
      // Direct sandbox delete verifies the exact scanned Bin bytes, without bypassing UI confirmation tests.
      await r.del(Buffer.from(scan.json.keys.find((k: { key: { data: string } }) => k.key.data === bom).key.data));
      expect(await r.get(plain)).toBe('plain');
    } finally { await r.del([plain, bom]); }
  });

  it('large values: a 10 MB string can be written and is previewed/truncated on read', async () => {
    const c = await userSession(t, 'operator');
    const big = 'q'.repeat(10 * 1024 * 1024);
    let res = await c.req('POST', '/api/v1/databases/e2e/ops', { op: 'string.set', key: { enc: 'utf8', data: `${P}large` }, value: { enc: 'utf8', data: big } });
    expect(res.status).toBe(200);
    res = await c.req('POST', '/api/v1/databases/e2e/key/read', { key: bk(`${P}large`), full: true });
    expect(res.json.value.totalBytes).toBe(big.length);
    expect(res.json.value.truncated).toBe(true);
    expect(res.json.value.value.data.length).toBe(524_288);
    // Over the 12 MB body limit -> 413
    res = await c.req('POST', '/api/v1/databases/e2e/ops', { op: 'string.set', key: { enc: 'utf8', data: `${P}toolarge` }, value: { enc: 'utf8', data: 'q'.repeat(13 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('too_large');
  });
});
