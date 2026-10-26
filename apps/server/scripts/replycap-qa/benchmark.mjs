import { direct } from './redis.mjs';
import { local } from './lib.mjs';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const r = await direct(6412);
const P='rc-replycap:bench:';
// Small fixtures only, to cover the other types.
await r.sendCommand(['JSON.SET',P+'json','$',JSON.stringify({items:Array.from({length:30},(_,i)=>({id:i,name:'name '+i}))})]);
await r.del([P+'list',P+'stream']);
await r.rPush(P+'list', ['one','two','three']);
await r.xAdd(P+'stream','*',{field:'value'});
await r.hSet(P+'hash',{name:'replycap benchmark',text:'ordinary search document'});
await r.sendCommand(['FT.CREATE',P+'idx','ON','HASH','PREFIX','1',P+'hash','SCHEMA','text','TEXT']).catch(e=>{if(!/exists/i.test(e.message))throw e});
const file='/tmp/rc-replycap-bench-commands.json';
let cmds;
if(existsSync(file))cmds=JSON.parse(readFileSync(file));
else {
const first={};let cur='0';
do {const page=await r.scan(cur,{COUNT:1000});cur=page.cursor;for(const k of page.keys){if(k.startsWith(P))continue;const t=await r.type(k);first[t]??=k;} }while(cur!=='0'&&(!first.string||!first.hash||!first.zset));
cmds=[['GET',first.string],['HGETALL',first.hash],['JSON.GET',P+'json'],['JSON.GET',P+'json','$.items[*].id'],['FT.SEARCH',P+'idx','ordinary'],['FT.AGGREGATE',P+'idx','*','LOAD','1','@text','LIMIT','0','10'],['ZRANGE',first.zset,'0','19','WITHSCORES'],['XRANGE',P+'stream','-','+','COUNT','10'],['LRANGE',P+'list','0','9'],['SCAN','0','COUNT','100'],['SLOWLOG','GET','10']];writeFileSync(file,JSON.stringify(cmds));
}
const v=await local('qa-viewer');const out=[];
for(const argv of cmds){const ms=[];let statuses=new Set();for(let i=0;i<65;i++){let t=performance.now();const x=await v.cli('snapshot',argv);const elapsed=performance.now()-t;statuses.add(x.status+':'+(x.json?.reply?.t??x.json?.error?.code));if(i>=15)ms.push(elapsed);await new Promise(r=>setTimeout(r,55));}ms.sort((a,b)=>a-b);out.push({command:argv[0]+(argv[0]==='JSON.GET'&&argv.length>2?' wildcard':''),statuses:[...statuses],p50:+ms[24].toFixed(2),p95:+ms[47].toFixed(2)});}
writeFileSync(process.argv[2]??'/tmp/rc-replycap-baseline.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));await r.quit();
