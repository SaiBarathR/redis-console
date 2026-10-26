import {BASE} from './lib.mjs';
const r=await fetch(BASE+'/api/v1/auth/oidc/start',{redirect:'manual'});
const r2=await fetch(r.headers.get('location'),{redirect:'manual'});
console.log({start:r.status,idp:r2.status});
