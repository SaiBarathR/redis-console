import assert from 'node:assert/strict';
import {oidc} from './lib.mjs';
const out={};
for(const user of ['viewer1','operator1','admin1']){
 const c=await oidc(user);
 for(const db of ['ro-e2e','viewer-e2e','op-e2e','prod-e2e']){
  const r=await c.cli(db,['CLIENT','INFO']);assert.equal(r.status,200);
  const role=db==='viewer-e2e'?'viewer':db==='op-e2e'&&user==='admin1'?'operator':user.replace('1','');
  assert.ok(r.json.reply.v.data.includes('user=rc-'+role));out[`${user}@${db}`]=role;
 }
 if(user==='admin1'){
  const r=await c.cli('prod-e2e',['SET','rc-review-s3:prod','x']);assert.equal(r.status,428);assert.equal(r.json.error.confirmation.level,'typed');assert.equal(r.json.error.confirmation.reasonRequired,true);out.prodSet='428 typed + reason';
 }
}
console.log(out);
