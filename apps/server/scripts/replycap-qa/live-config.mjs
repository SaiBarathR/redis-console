// Only secret references are copied. No credential is resolved or printed.
import {readFileSync,writeFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../../../../config/rconsole.dev.json',import.meta.url)));
const base=config.databases.find(d=>d.id==='sandbox-e2e');
if(!base||new URL(base.url).port!=='6411')throw Error('expected disposable 6411 database');
for(const [id,extra] of [['ro-e2e',{readOnly:true}],['viewer-e2e',{maxRole:'viewer'}],['op-e2e',{maxRole:'operator'}],['prod-e2e',{environment:'prod'}]])config.databases.push({...base,id,name:id,...extra});
writeFileSync('/tmp/rc-replycap-live-config.json',JSON.stringify(config,null,2));
