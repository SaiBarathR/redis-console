// Read-only comparison probes on 6412. Generate the b9ea7e2 source snapshot inside apps/server/scripts first.
import { buildApp } from '../.replycap-baseline/apps/server/src/app.ts';
import { testConfig, userSession } from '../../test/helpers.ts';
const {app,ctx}=await buildApp(testConfig(),{logger:false,dbPath:':memory:',auditWrite:()=>{}});await app.ready();
const t={app,ctx,close:()=>app.close()},a=await userSession(t,'viewer'),b=await userSession(t,'viewer');
const cli=async(c,argv)=>{const start=performance.now();const r=await c.req('POST','/api/v1/databases/main/cli',{argv});return {status:r.status,ms:+(performance.now()-start).toFixed(2)};};
// Use only the permitted example copy; replace the harness's 6410 read-only definition before connecting.
const db=ctx.redis.database('main');db.url='redis://127.0.0.1:6412';
try{
 console.log('baseline ping',await cli(b,['PING']));
 const flood=Array.from({length:20},()=>a.req('POST','/api/v1/databases/main/keys/scan',{match:'*',count:1000,cursor:'0'}));
 await new Promise(r=>setTimeout(r,30));
 console.log('ping during old scan flood',await Promise.all([cli(b,['PING']),new Promise(r=>setTimeout(r,200)).then(()=>cli(b,['PING'])),new Promise(r=>setTimeout(r,600)).then(()=>cli(b,['PING']))]));
 console.log('flood statuses',(await Promise.all(flood)).map(r=>r.status));
 console.log('old 9999-key MGET',await cli(b,['MGET',...Array.from({length:9999},(_,i)=>'rc-replycap:absent:'+i)]));
 if(global.gc)global.gc();
 const argv=['FT.AGGREGATE','noidx','*','LOAD','1','@x'];for(let i=0;i<20;i++)argv.push('APPLY','@x+@x','AS','x');argv.push('LIMIT','0','10');
 const h=process.memoryUsage().heapUsed;console.log('old alias20',await cli(b,argv),'heapDeltaMiB',+((process.memoryUsage().heapUsed-h)/1048576).toFixed(1));
}finally{await app.close();}
