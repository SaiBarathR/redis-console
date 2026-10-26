import { direct } from './redis.mjs';
for (const port of [6411, 6412]) {
  const r = await direct(port); let cursor = '0', found = [];
  do { const res = await r.scan(cursor, { MATCH: 'rc-review-s3*', COUNT: 1000 }); cursor = String(res.cursor); found.push(...res.keys); } while (cursor !== '0');
  console.log(port, found.length, found.slice(0, 5).map((k) => k.slice(0, 60)));
  if (port === 6411) console.log('dict', (await r.sendCommand(['FT.DICTDUMP', 'rc-review-s3-dict']).catch(() => [])).length);
  await r.quit();
}
