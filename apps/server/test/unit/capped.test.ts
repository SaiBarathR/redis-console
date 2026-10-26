import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CappedPool, CommandBudget, type RedirectPolicy } from '../../src/redis/capped.ts';
import { RespReader } from '../../src/redis/resp.ts';
import type { DatabaseConfig } from '../../src/config.ts';
const cleanups:(()=>Promise<void>)[]=[];
const anyPrimary:RedirectPolicy={allow:async()=>true};
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function server(command:(args:string[],socket:net.Socket)=>void, autoInit=true){
 const sockets=new Set<net.Socket>(),seen:string[][]=[];
 const srv=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  let reader=new RespReader(128*1024);
  socket.on('data',chunk=>{
   try{for(let i=0;i<chunk.length;){i+=reader.feed(chunk.subarray(i),true);if(reader.done){const args=(reader.value as unknown[]).map(String);reader=new RespReader(128*1024);seen.push(args);if(autoInit && (args[0]==='HELLO'||args[0]==='SELECT'))socket.write('+OK\r\n');else command(args,socket);}}}
   catch{socket.destroy();}
  });
 });
 await new Promise<void>(r=>srv.listen(0,'127.0.0.1',r));
 cleanups.push(()=>new Promise<void>(r=>{for(const socket of sockets)socket.destroy();srv.close(()=>r());}));
 return {endpoint:{host:'127.0.0.1',port:(srv.address() as net.AddressInfo).port},seen,sockets};
}
function pool(port:number,budget=new CommandBudget(2),size=2){
 const db:DatabaseConfig={id:'fake',name:'Fake',environment:'test',mode:'standalone',url:`redis://127.0.0.1:${port}`,db:2,credentials:{default:{username:'default'}},poolSize:size,maxRole:'admin',readOnly:false};
 const p=new CappedPool(db,db.credentials.default!,'viewer',1024,budget,new CommandBudget(16));cleanups.push(async()=>p.close());return p;
}
describe('exclusive capped socket transport',()=>{
 it('authenticates/names/selects, reuses only complete replies and drops overflow connections',async()=>{
  const s=await server(([cmd],sock)=>sock.write(cmd==='BIG'?'$100000000\r\n':'+PONG\r\n'));
  const p=pool(s.endpoint.port);
  expect(await p.send(['PING'],s.endpoint)).toBe('PONG');expect(await p.send(['PING'],s.endpoint)).toBe('PONG');
  expect(s.seen.filter(a=>a[0]==='HELLO')).toHaveLength(1);expect(s.seen.find(a=>a[0]==='SELECT')).toEqual(['SELECT','2']);
  await expect(p.send(['BIG'],s.endpoint)).rejects.toMatchObject({code:'too_large'});
  expect(await p.send(['PING'],s.endpoint)).toBe('PONG');expect(s.seen.filter(a=>a[0]==='HELLO')).toHaveLength(2);
 });
 it('never reuses a socket whose AUTH/HELLO or SELECT failed, including passwordless named users',async()=>{
  for(const failed of ['HELLO','SELECT']){
   const s=await server(([cmd],sock)=>sock.write(cmd===failed?'-NOPERM denied\r\n':'+OK\r\n'),false);
   const db:DatabaseConfig={id:'fake',name:'Fake',environment:'test',mode:'standalone',db:2,credentials:{default:{username:'named-user'}},poolSize:1,maxRole:'admin',readOnly:false};
   const p=new CappedPool(db,db.credentials.default!,'viewer',1024,new CommandBudget(),new CommandBudget());cleanups.push(async()=>p.close());
   for(let i=0;i<2;i++)await expect(p.send(['GET','key'],s.endpoint)).rejects.toThrow('NOPERM');
   expect(s.seen.filter(a=>a[0]==='HELLO')).toHaveLength(2);
   expect(s.seen.some(a=>a[0]==='GET')).toBe(false);
   expect(s.seen.find(a=>a[0]==='HELLO')).toEqual(['HELLO','3','AUTH','named-user','','SETNAME','rconsole-viewer-capped']);
  }
 });
 it('retries MOVED once and uses ASKING immediately before an ASK retry',async()=>{
  const dest=await server(([cmd],sock)=>sock.write(cmd==='ASKING'?'+OK\r\n':'$3\r\nyes\r\n'));
  for(const kind of ['MOVED','ASK']){
   const origin=await server((_,sock)=>sock.write(`-${kind} 1 127.0.0.1:${dest.endpoint.port}\r\n`));
   const p=pool(origin.endpoint.port);const before=dest.seen.length;
   expect(await p.send(['GET','key'],origin.endpoint,{},anyPrimary)).toBe('yes');
   const commands=dest.seen.slice(before).map(a=>a[0]);expect(commands).toEqual(kind==='ASK'?['HELLO','SELECT','ASKING','GET']:['HELLO','SELECT','GET']);
  }
 });
 it('never retries a second redirect, a timeout, or an ambiguous network failure',async()=>{
  let targetPort=0;
  const s=await server(([cmd],sock)=>{if(cmd==='REDIRECT')sock.write(`-MOVED 1 127.0.0.1:${targetPort}\r\n`);else if(cmd==='DROP')sock.destroy();});targetPort=s.endpoint.port;
  const p=pool(targetPort);
  await expect(p.send(['REDIRECT'],s.endpoint,{},anyPrimary)).rejects.toThrow('MOVED');expect(s.seen.filter(a=>a[0]==='REDIRECT')).toHaveLength(2);
  await expect(p.send(['DROP'],s.endpoint,{},anyPrimary)).rejects.toMatchObject({code:'unavailable'});expect(s.seen.filter(a=>a[0]==='DROP')).toHaveLength(1);
  await expect(p.send(['HANG'],s.endpoint,{timeout:30},anyPrimary)).rejects.toThrow();expect(s.seen.filter(a=>a[0]==='HANG')).toHaveLength(1);
 });
 it('shares cumulative typed budgets and refuses global or per-pool work after a short bounded wait (review v0.2 r4 M1)',async()=>{
  const s=await server(([cmd],sock)=>{if(cmd==='PING')sock.write('+PONG\r\n');else if(cmd==='VALUE')sock.write('$6\r\nabcdef\r\n');});
  const p=pool(s.endpoint.port,new CommandBudget(1),1),stop=new AbortController();
  const hang=expect(p.send(['HANG'],s.endpoint,{signal:stop.signal})).rejects.toMatchObject({code:'unavailable'});
  await new Promise(r=>setTimeout(r,30));await expect(p.send(['PING'],s.endpoint,{timeout:50})).rejects.toMatchObject({code:'rate_limited'});stop.abort();await hang;
  const budget={remaining:20};expect(await p.send(['VALUE'],s.endpoint,{replyBudget:budget})).toBe('abcdef');expect(budget.remaining).toBe(8);
  await expect(p.send(['VALUE'],s.endpoint,{replyBudget:budget})).rejects.toMatchObject({code:'too_large'});expect(budget.remaining).toBe(0);
 });
 it('closes a dedicated stream when one event would retain more than the event limit',async()=>{
  // A single long string arrives cut (review v0.2 r4 M4); an event whose kept parts exceed 256 KiB still fails closed.
  const big='$70000\r\n'+'x'.repeat(70000)+'\r\n';
  const s=await server(([cmd],sock)=>{if(cmd==='SUBSCRIBE'){sock.write('>3\r\n+subscribe\r\n$1\r\nc\r\n:1\r\n');setTimeout(()=>sock.write('>6\r\n+message\r\n$1\r\nc\r\n'+big.repeat(4)),20);}});
  const p=pool(s.endpoint.port),c=await p.dedicated(s.endpoint);
  const error=new Promise<unknown>(r=>c.onError(r));await c.subscribe(['c'],()=>{throw Error('oversize push delivered');},true);expect(await error).toMatchObject({code:'too_large'});
 });
 it('an unsolicited push or malformed input cannot return its socket to the pool',async()=>{
  const s=await server(([cmd],sock)=>sock.write(cmd==='PUSH'?'>1\r\n+oops\r\n':cmd==='MALFORMED'?'#bad\r\n':'+PONG\r\n'));
  const p=pool(s.endpoint.port);
  await expect(p.send(['PUSH'],s.endpoint)).rejects.toMatchObject({code:'redis_error'});
  await expect(p.send(['MALFORMED'],s.endpoint)).rejects.toMatchObject({code:'redis_error'});
  expect(await p.send(['PING'],s.endpoint)).toBe('PONG');expect(s.seen.filter(a=>a[0]==='HELLO')).toHaveLength(3);
 });
});

describe('metadata pipeline on the measured transport (key browser v0.2.1)',()=>{
 /** Replies to a batch only once all of it arrived, in one write, so the test proves a single round trip. */
 async function batchServer(reply:(args:string[])=>string,expected:number){
  const batches:number[]=[];let pending:string[]=[];let seen=0;
  const s=await server((args,sock)=>{pending.push(reply(args));seen++;if(pending.length===expected){batches.push(seen);sock.write(pending.join(''));pending=[];}});
  return {...s,batches};
 }
 it('writes the whole batch at once and returns replies in order, error replies included',async()=>{
  const s=await batchServer(([cmd,key,sub])=>cmd==='TYPE'?(key==='gone'?'+none\r\n':'+hash\r\n'):cmd==='PTTL'?':-1\r\n':sub==='gone'?'_\r\n':'-NOPERM no memory\r\n',6);
  const p=pool(s.endpoint.port);
  const out=await p.pipeline([['TYPE','k'],['PTTL','k'],['MEMORY','USAGE','k'],['TYPE','gone'],['PTTL','gone'],['MEMORY','USAGE','gone']],s.endpoint);
  expect(out.slice(0,2)).toEqual(['hash',-1]);expect(out[2]).toBeInstanceOf(Error);expect(String((out[2] as Error).message)).toContain('NOPERM');
  expect(out.slice(3)).toEqual(['none',-1,null]);expect(s.batches).toEqual([6]);
  // The socket stays usable after a complete batch (error replies leave it clean).
  expect(s.sockets.size).toBe(1);
 });
 it('measures every reply: an oversized one fails the batch and drops the socket; a shared budget is charged',async()=>{
  const s=await server(([cmd],sock)=>sock.write(cmd==='BIG'?'$5000\r\n'+'x'.repeat(5000)+'\r\n':'+ok\r\n'));
  const p=pool(s.endpoint.port);
  await expect(p.pipeline([['SMALL'],['BIG'],['SMALL']],s.endpoint)).rejects.toMatchObject({code:'too_large'});
  const budget={remaining:12};
  await expect(p.pipeline([['SMALL'],['SMALL'],['SMALL'],['SMALL']],s.endpoint,{replyBudget:budget})).rejects.toMatchObject({code:'too_large'});
  expect(budget.remaining).toBe(0);
  expect(await p.pipeline([['SMALL'],['SMALL']],s.endpoint)).toEqual(['ok','ok']);
 });
 it('refuses bytes after the last expected reply and unsolicited pushes',async()=>{
  for(const extra of ['+ok\r\n+extra\r\n','>1\r\n+oops\r\n']){
   const s=await server((_,sock)=>sock.write(extra));
   const p=pool(s.endpoint.port);
   await expect(p.pipeline([['ONE']],s.endpoint)).rejects.toMatchObject({code:'redis_error'});
   await expect.poll(()=>s.sockets.size).toBe(0);
  }
 });
 it('checks the actor once, right before the batch is written; a revoked actor sends nothing',async()=>{
  const s=await server((_,sock)=>sock.write('+ok\r\n'));
  const p=pool(s.endpoint.port);
  let checks=0;
  expect(await p.pipeline([['A'],['B']],s.endpoint,{stillAllowed:()=>{checks++;return true;}})).toEqual(['ok','ok']);expect(checks).toBe(1);
  const before=s.seen.length;
  await expect(p.pipeline([['C'],['D']],s.endpoint,{stillAllowed:()=>false})).rejects.toMatchObject({code:'unauthenticated'});
  expect(s.seen.slice(before).filter(a=>a[0]==='C'||a[0]==='D')).toHaveLength(0);
 });
 it('times out as one exchange and drops the socket',async()=>{
  const s=await server(([cmd],sock)=>{if(cmd!=='HANG')sock.write('+ok\r\n');});
  const p=pool(s.endpoint.port);
  await expect(p.pipeline([['A'],['HANG']],s.endpoint,{timeout:50})).rejects.toThrow();
  await expect.poll(()=>s.sockets.size).toBe(0);
 });
});
