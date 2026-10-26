// Adapted from every round-3 evidence script. Run against this branch's own :4600 instance.
// Source .env first. Argument is the PID of that server (never discover/kill by pattern).
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { direct } from './redis.mjs';
const pid=Number(process.argv[2]);if(!Number.isInteger(pid)||pid<1)throw Error('server PID required');
const cases=['leftovers','smoke','ver','dbg','acl','apply-blowup','h1-sampling','h1-sampling2','h2-unsized','h2b-range','h3-keynames','json-false','kb-stream','dictdump','redis7','everyday','mget-latency','mget-probes','fairness','small-confirms','audit-echo','noperm','tiers','matrix','matrix2','leftovers'];
const out=[];
for(let i=0;i<cases.length;i++){
 const name=cases[i];process.argv=['node',name,...(['h2-unsized','h2b-range','kb-stream'].includes(name)?[String(pid)]:[])];
 console.log('\nCASE '+name);
 let before=Number(execFileSync('ps',['-o','rss=','-p',String(pid)]).toString().trim()),peak=before;
 const sampling=setInterval(()=>{try{peak=Math.max(peak,Number(execFileSync('ps',['-o','rss=','-p',String(pid)]).toString().trim()));}catch{}},25);
 const start=performance.now();let error;
 try{await import(`./${name}.mjs?run=${i}`);}
 catch(e){error=e.message;console.log('SCRIPT ERROR',error);}
 finally{clearInterval(sampling);}
 out.push({name,ms:Math.round(performance.now()-start),rssBeforeMiB:+(before/1024).toFixed(1),rssPeakMiB:+(peak/1024).toFixed(1),...(error?{error}:{})});
 await new Promise(r=>setTimeout(r,1100));
}
writeFileSync('/tmp/rc-replycap-r3-summary.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
// Guarded cleanup, including fixtures left by an interrupted script; only the review prefix on 6411.
const r=await direct(6411);let cur='0';const keys=[];
do{const p=await r.scan(cur,{MATCH:'rc-review-s3*',COUNT:1000});cur=p.cursor;keys.push(...p.keys);}while(cur!=='0');
for(let i=0;i<keys.length;i+=100)await r.del(keys.slice(i,i+100));
await r.quit();
