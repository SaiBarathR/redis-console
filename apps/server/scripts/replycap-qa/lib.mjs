import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const BASE = process.env.RC_BASE ?? 'http://localhost:4600';
const ACC = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
const localClients = new Map();
const oidcClients = new Map();
function base32Decode(s) { const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits=0,val=0; const out=[]; for (const ch of s.replace(/=+$/,'').toUpperCase()){const i=a.indexOf(ch); if(i<0)continue; val=(val<<5)|i; bits+=5; if(bits>=8){out.push((val>>>(bits-8))&0xff); bits-=8;}} return Buffer.from(out); }
export function totp(secret, step = Math.floor(Date.now() / 30000)) { const b=Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step)); const h=createHmac('sha1', base32Decode(secret)).update(b).digest(); const o=h[h.length-1]&15; return String(((h.readUInt32BE(o)&0x7fffffff)%1e6)).padStart(6,'0'); }
export class Client {
  jar = new Map(); csrf = '';
  setCookies(url, res) { const host=new URL(url).host; const m=this.jar.get(host)??new Map(); for (const c of res.headers.getSetCookie()){const [nv]=c.split(';'); const i=nv.indexOf('='); m.set(nv.slice(0,i).trim(), nv.slice(i+1));} this.jar.set(host,m); }
  cookie(url) { const m=this.jar.get(new URL(url).host); return m?[...m].map(([k,v])=>`${k}=${v}`).join('; '):''; }
  async fetch(url, init={}) { const headers={...(init.headers??{}), Cookie:this.cookie(url)}; const res=await fetch(url,{...init,headers,redirect:'manual'}); this.setCookies(url,res); return res; }
  async follow(url, init={}) { let res=await this.fetch(url,init); for(let i=0;i<10&&res.status>=300&&res.status<400;i++){url=new URL(res.headers.get('location'),url).toString(); res=await this.fetch(url);} return {res,url}; }
  async api(method, p, body, extraHeaders={}) {
    const headers={Accept:'application/json', ...extraHeaders};
    if (method!=='GET'){headers['Content-Type']='application/json'; headers.Origin ??= BASE; if(this.csrf) headers['X-CSRF-Token']=this.csrf;}
    const t0=Date.now();
    const res=await this.fetch(BASE+p,{method,headers,body:method==='GET'?undefined:(typeof body==='string'?body:JSON.stringify(body??{}))});
    const text=await res.text(); let json; try{json=JSON.parse(text);}catch{json=undefined;}
    return {status:res.status,json,text,ms:Date.now()-t0,bytes:text.length};
  }
  async refreshMe(){ const r=await this.api('GET','/api/v1/auth/me'); if(r.status===200) this.csrf=r.json.csrfToken??r.json.me?.csrfToken??''; return r; }
  cli(db, argv, extra={}) { return this.api('POST', `/api/v1/databases/${db}/cli`, { argv, ...extra }); }
}
export async function local(name) {
  if (localClients.has(name)) return localClients.get(name);
  const acc = ACC.local[name]; const c = new Client();
  let r = await c.api('POST','/api/v1/auth/login',{username:acc.username,password:acc.password});
  if (r.status!==200) throw new Error('login '+name+' '+r.status+' '+r.text);
  if (r.json?.totpRequired) { r = await c.api('POST','/api/v1/auth/totp/verify',{code:totp(acc.totpSecret)}); if (r.status!==200) { await new Promise(s=>setTimeout(s,31000)); r = await c.api('POST','/api/v1/auth/totp/verify',{code:totp(acc.totpSecret)}); } if(r.status!==200) throw new Error('totp '+name+' '+r.text); }
  await c.refreshMe(); localClients.set(name,c); return c;
}
export async function oidc(username) {
  if (oidcClients.has(username)) return oidcClients.get(username);
  const c = new Client();
  const { res } = await c.follow(`${BASE}/api/v1/auth/oidc/start`);
  const html = await res.text();
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g,'&');
  const form = new URLSearchParams({ username, password: process.env.KC_USER_PASSWORD, credentialId: '' });
  await c.follow(action, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form.toString() });
  await c.refreshMe(); oidcClients.set(username,c); return c;
}
export const ACCOUNTS = ACC;
