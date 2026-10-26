import {direct} from './redis.mjs';
for(const port of [6411,6412]){
 const r=await direct(port);const prefix=port===6411?'rc-review-s3*':'rc-replycap:bench:*';
 if(port===6412)await r.sendCommand(['FT.DROPINDEX','rc-replycap:bench:idx']).catch(e=>{if(!/no such index|Unknown Index name|Index not found/i.test(e.message))throw e;});
 let cursor='0';const keys=[];do{const p=await r.scan(cursor,{MATCH:prefix,COUNT:1000});cursor=p.cursor;keys.push(...p.keys);}while(cursor!=='0');
 for(let i=0;i<keys.length;i+=100)await r.del(keys.slice(i,i+100));
 cursor='0';let remaining=0;do{const page=await r.scan(cursor,{MATCH:prefix,COUNT:1000});cursor=page.cursor;remaining+=page.keys.length;}while(cursor!=='0');
 if(remaining)throw Error('fixtures remain');
 console.log({port,deleted:keys.length});await r.quit();
}
