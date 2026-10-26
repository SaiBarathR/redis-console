/** Round 3: measurement, not averages. Fixtures live only on disposable 6411. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TimeoutError } from 'redis';
import { bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';
import { failureDetail } from '../../src/audit.ts';
import { toHttpError } from '../../src/redis/exec.ts';
import { fixedReply } from '../../src/redis/manager.ts';
import { ErrorReply } from 'redis';
const CLI='/api/v1/databases/e2e/cli';
const P=keyPrefix('r3cap');
describe.skipIf(!sandboxUp)('round 3 measured reply regressions',()=>{
 let t:TestApp,r:Awaited<ReturnType<typeof sandboxAdmin>>,v:Client;
 beforeAll(async()=>{
  const cfg=testConfig();cfg.policy.maxReadReplyBytes=256*1024;
  t=await startApp(cfg);r=await sandboxAdmin();v=await userSession(t,'viewer');
  await r.rPush(P+'list',['x'.repeat(2*1024*1024),...Array(20_000).fill('a')]);
  await r.xAdd(P+'stream','1-1',{payload:'x'.repeat(2*1024*1024)});
  for(let batch=0;batch<10;batch++){const m=r.multi();for(let i=0;i<1000;i++)m.xAdd(P+'stream','*',{a:'b'});await m.exec();}
  await r.xAdd(P+'stream','*',{payload:'z'.repeat(2*1024*1024)});
  await r.sendCommand(['JSON.SET',P+'json','$',JSON.stringify({items:Array.from({length:400},(_,id)=>({id,name:'item '+id,tags:['a','b'],text:'lorem ipsum '.repeat(20)}))})]);
  await r.hSet(P+'hash',{a:'small',b:'x'.repeat(2*1024*1024)});
 });
 beforeEach(async()=>{v=await userSession(t,'viewer');});
 afterAll(async()=>{await t?.close();await r?.close();await cleanupPrefix(P);});
 it('H1: thirty alias-doubling APPLY steps do no local expansion, including FT.PROFILE',async()=>{
  for(const cmd of ['FT.AGGREGATE','FT.PROFILE']){
   const argv=cmd==='FT.AGGREGATE'?[cmd,'noidx','*','LOAD','1','@x']:[cmd,'noidx','AGGREGATE','QUERY','*','LOAD','1','@x'];
   for(let i=0;i<30;i++)argv.push('APPLY','@x+@x','AS','x');
   const before=process.memoryUsage().heapUsed,start=performance.now();
   const out=await v.req('POST',CLI,{argv});expect(out.status).toBe(200);expect(out.json.reply.t).toBe('err');
   expect(performance.now()-start).toBeLessThan(1000);expect(process.memoryUsage().heapUsed-before).toBeLessThan(32*1024*1024);
  }
 });
 it.each([
  ['XINFO','STREAM','stream'],['XINFO','STREAM','stream','FULL','COUNT','1'],
  ['LRANGE','list','0','2'],['LINDEX','list','0'],['XRANGE','stream','-','+','COUNT','1'],['XREVRANGE','stream','+','-','COUNT','1'],
  ['HGETALL','hash'],['HVALS','hash'],['HSCAN','hash','0','COUNT','1000'],
 ])('H2: caps %j and recovers on the next command',async(...args:string[])=>{
  const argv=args.map(a=>['stream','list','hash'].includes(a)?P+a:a);const start=performance.now();
  const out=await v.req('POST',CLI,{argv});expect(out.status,JSON.stringify(out.json)).toBe(413);expect(out.json.error.code).toBe('too_large');expect(out.json.error.hint).toMatch(/SCAN\/COUNT\/ranges/);
  expect(performance.now()-start).toBeLessThan(1500);
  const ping=await v.req('POST',CLI,{argv:['PING']});expect(ping.status).toBe(200);
 });
 it('H2: counts long key names for SCAN, RANDOMKEY, and typed scans',async()=>{
  const name=P+'long:'+ 'k'.repeat(400*1024);await r.set(name,'1');
  try{
   // MATCH can legitimately produce an empty first page when other sandbox users have keys.
   // Walk the cursor: the cap must refuse the page that actually contains the long key.
   for(const typed of [false,true]){
    let cursor='0',capped=false;
    for(let pages=0;pages<200;pages++){
     const res=typed
      ?await v.req('POST','/api/v1/databases/e2e/keys/scan',{match:P+'long:*',count:1000,cursor})
      :await v.req('POST',CLI,{argv:['SCAN',cursor,'MATCH',P+'long:*','COUNT','1000']});
     if(res.status===413){capped=true;break;}
     expect(res.status,JSON.stringify(res.json)).toBe(200);
     cursor=typed?res.json.cursor:res.json.reply.v[0].v.data;
     if(cursor==='0')break;
     await new Promise(resolve=>setTimeout(resolve,110));
    }
    expect(capped,'the scan must eventually encounter and cap the long key').toBe(true);
   }
   // RANDOMKEY has random selection: assert either a measured success or a cap refusal, never an oversized tree.
   const out=await v.req('POST',CLI,{argv:['RANDOMKEY']});expect([200,413]).toContain(out.status);expect(out.body.length).toBeLessThan(300*1024);
  }finally{await r.del(name);}
 });
 it('typed stream/hash/list reads also use the measured path',async()=>{
  for(const k of ['stream','hash','list'])expect((await v.req('POST','/api/v1/databases/e2e/key/read',{key:bk(P+k),count:100})).status).toBe(413);
 });
 it('JSON wildcard reads on a 120 KB document all succeed without MEMORY/DEBUG probes',async()=>{
  for(const argv of [['JSON.TYPE',P+'json','$.*'],['JSON.OBJLEN',P+'json','$.items[*]'],['JSON.STRLEN',P+'json','$.items[*].name'],['JSON.ARRLEN',P+'json','$..tags'],['JSON.GET',P+'json','$.items[*].id'],['JSON.OBJKEYS',P+'json','$.items[0]']]){
   const out=await v.req('POST',CLI,{argv});expect(out.status,JSON.stringify(out.json)).toBe(200);expect(out.json.reply.t).not.toBe('err');
  }
 });
 it('MGET sends one command and no sequential STRLEN probes (9,999 missing keys)',async()=>{
  const calls=async()=>Number(/cmdstat_strlen:calls=(\d+)/.exec(String(await r.sendCommand(['INFO','commandstats'])))?.[1]??0);
  const before=await calls();const out=await v.req('POST',CLI,{argv:['MGET',...Array.from({length:9999},(_,i)=>P+'absent:'+i)]});expect(out.status).toBe(200);expect(await calls()).toBe(before);
 });
 it('all roles use their own credentials on capped commands',async()=>{
  for(const role of ['viewer','operator','admin'] as const){const c=await userSession(t,role);const out=await c.req('POST',CLI,{argv:['CLIENT','INFO']});expect(out.status).toBe(200);expect(out.json.reply.v.data).toContain('user=rc-'+role);}
 });
 it('an abort or timeout destroys only the command socket and releases capacity',async()=>{
  const c=await t.ctx.redis.conn('e2e','viewer'),stop=new AbortController();
  const aborted=c.send(['XREAD','BLOCK','0','STREAMS',P+'absent','$'],{key:P+'absent',signal:stop.signal,timeout:2000});
  const check=expect(aborted).rejects.toMatchObject({code:'unavailable'});setTimeout(()=>stop.abort(),50);await check;
  await expect(c.send(['XREAD','BLOCK','0','STREAMS',P+'absent','$'],{key:P+'absent',timeout:50})).rejects.toBeInstanceOf(TimeoutError);
  expect(await t.ctx.redis.conn('e2e','viewer')).toBe(c);
  expect(await c.send(['PING'],{capped:true})).toBe('PONG');
 });
 it('errors from probes can no longer disable a bound, and input echo is never considered fixed-size',()=>{
  for(const argv of [['MEMORY','STATS'],['PING','arbitrary'],['GET','k'],['XINFO','STREAM','k'],['SCAN','0'],['FT.DICTDUMP','d'],['COMMAND','DOCS']])expect(fixedReply(argv)).toBe(false);
  expect(fixedReply(['MEMORY','USAGE','k'])).toBe(true);
 });
 it('allows the stream UI to refresh four related reads concurrently while rejecting a fifth',async()=>{
  await r.sendCommand(['XGROUP','CREATE',P+'stream','ui-group','0']);
  const c=await t.ctx.redis.conn('e2e','viewer'),send=c.send.bind(c);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  c.send=async(args,o)=>{if(String(args[0])==='XPENDING')await gate;return send(args,o);};
  const url='/api/v1/databases/e2e/streams/pending',body={key:bk(P+'stream'),group:'ui-group'};
  const pending=Array.from({length:4},()=>v.req('POST',url,body));
  try{
   await new Promise(resolve=>setTimeout(resolve,30));
   expect((await v.req('POST',url,body)).status).toBe(429);
   release();for(const response of await Promise.all(pending))expect(response.status).toBe(200);
  }finally{release();await Promise.all(pending);c.send=send;}
 });
 it('audit errors never persist NOPERM key names or search argument text',async()=>{
  const e=toHttpError(new ErrorReply('NOPERM No permissions to access customer:alice@example.com'));
  expect(failureDetail(e.code,e.message)).not.toContain('alice');
  const out=await v.req('POST',CLI,{argv:['FT.SEARCH','noidx','*','FORMAT','r3-audit-canary']});expect(out.json.reply.t).toBe('err');
  expect(t.auditLines.join('')).not.toContain('r3-audit-canary');
 });
});
