// Actual aggregate payload crosses 16 MiB after a 10 MiB bulk has been received.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {direct} from './redis.mjs';
import {local} from './lib.mjs';
const pid=Number(process.argv[2]);if(!Number.isInteger(pid)||pid<1)throw Error('own server PID required');
const rss=()=>Number(execFileSync('ps',['-o','rss=','-p',String(pid)]).toString().trim())*1024;
const r=await direct(6411),v=await local('qa-viewer'),keys=['rc-review-s3:rss-a','rc-review-s3:rss-b'];
try{
 for(const key of keys)await r.set(key,'x'.repeat(10*1024*1024));
 await v.cli('sandbox-e2e',['PING']);const before=rss();let peak=before;
 const sample=setInterval(()=>{peak=Math.max(peak,rss());},5),results=[];
 try{for(let i=0;i<8;i++){const res=await v.cli('sandbox-e2e',['MGET',...keys]);assert.equal(res.status,413);assert.equal(res.json.error.code,'too_large');assert.ok(res.ms<1500);results.push({status:res.status,ms:res.ms});await new Promise(r=>setTimeout(r,70));}}
 finally{clearInterval(sample);}
 const report={replyBytes:20*1024*1024,capBytes:16*1024*1024,commands:results,rssBeforeMiB:+(before/1048576).toFixed(1),rssPeakMiB:+(peak/1048576).toFixed(1),rssDeltaMiB:+((peak-before)/1048576).toFixed(1)};
 // RSS includes allocator retention, JS decoding and initialized clients as well as live raw buffers.
 assert.ok(peak-before<96*1024*1024,'RSS did not remain bounded across repeated aggregate overflow');
 writeFileSync('/tmp/rc-replycap-rss.json',JSON.stringify(report,null,2));console.log(report);
}finally{await r.del(keys);await r.quit();}
