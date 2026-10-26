#!/usr/bin/env node
// Provisions local QA accounts for every role on a running Redis Console, for hands-on testing.
// Signs in as the Keycloak user admin1 (OIDC), creates qa-viewer / qa-operator / qa-admin (and qa-admin2),
// completes the forced password change and TOTP enrollment, and writes the credentials to .qa/accounts.json
// (gitignored, mode 600). Re-running recreates any account that no longer signs in.
//
//   set -a; source .env; set +a; node scripts/qa-accounts.mjs [baseUrl]      (default http://localhost:4000)
//   node scripts/qa-accounts.mjs --totp qa-admin                             (prints a current TOTP code)
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, '.qa', 'accounts.json');

function base32Decode(s) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = a.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(b).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

if (process.argv[2] === '--totp') {
  const accs = JSON.parse(readFileSync(FILE, 'utf8'));
  const a = accs.local[process.argv[3]];
  if (!a?.totpSecret) { console.error('no TOTP secret for', process.argv[3]); process.exit(1); }
  console.log(totp(a.totpSecret));
  process.exit(0);
}

const BASE = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;

class Client {
  jar = new Map(); // host -> Map(name -> value)
  csrf = '';
  setCookies(url, res) {
    const host = new URL(url).host;
    const m = this.jar.get(host) ?? new Map();
    for (const c of res.headers.getSetCookie()) {
      const [nv] = c.split(';'); const i = nv.indexOf('=');
      m.set(nv.slice(0, i).trim(), nv.slice(i + 1));
    }
    this.jar.set(host, m);
  }
  cookie(url) {
    const m = this.jar.get(new URL(url).host);
    return m ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }
  async fetch(url, init = {}) {
    const headers = { ...(init.headers ?? {}), Cookie: this.cookie(url) };
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.setCookies(url, res);
    return res;
  }
  async follow(url, init = {}) {
    let res = await this.fetch(url, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      url = new URL(res.headers.get('location'), url).toString();
      res = await this.fetch(url);
    }
    return { res, url };
  }
  async api(method, p, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers.Origin = ORIGIN; if (this.csrf) headers['X-CSRF-Token'] = this.csrf; }
    const res = await this.fetch(BASE + p, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  }
  async refreshMe() {
    const r = await this.api('GET', '/api/v1/auth/me');
    if (r.status === 200) this.csrf = r.json.csrfToken ?? r.json.me?.csrfToken ?? '';
    return r;
  }
}

async function oidcLogin(username, password) {
  const c = new Client();
  const { res, url } = await c.follow(`${BASE}/api/v1/auth/oidc/start`);
  const html = await res.text();
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  if (!action) throw new Error(`Keycloak login form not found at ${url} (status ${res.status})`);
  const form = new URLSearchParams({ username, password, credentialId: '' });
  const post = await c.follow(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (!post.url.startsWith(BASE)) throw new Error(`OIDC sign-in for ${username} did not return to the app (ended at ${new URL(post.url).origin})`);
  const me = await c.refreshMe();
  if (me.status !== 200) throw new Error(`OIDC sign-in for ${username} failed: ${me.status} ${me.text.slice(0, 200)}`);
  return c;
}

async function localLogin(acc) {
  const c = new Client();
  let r = await c.api('POST', '/api/v1/auth/login', { username: acc.username, password: acc.password });
  if (r.status !== 200) return null;
  if (r.json?.totpRequired) {
    if (!acc.totpSecret) return null;
    r = await c.api('POST', '/api/v1/auth/totp/verify', { code: totp(acc.totpSecret) });
    if (r.status !== 200) {
      await new Promise((s) => setTimeout(s, 31000));
      r = await c.api('POST', '/api/v1/auth/totp/verify', { code: totp(acc.totpSecret) });
      if (r.status !== 200) return null;
    }
  }
  await c.refreshMe();
  return c;
}

const newPassword = () => `Qa-${randomBytes(12).toString('base64url')}!`;

async function onboard(acc) {
  const c = await localLogin(acc);
  if (!c) throw new Error(`cannot sign in as ${acc.username}`);
  let me = (await c.refreshMe()).json;
  if (me.mustChangePassword) {
    const np = newPassword();
    const r = await c.api('POST', '/api/v1/auth/password', { currentPassword: acc.password, newPassword: np });
    if (r.status !== 200) throw new Error(`password change ${acc.username}: ${r.status} ${r.text.slice(0, 200)}`);
    acc.password = np;
    me = (await c.refreshMe()).json;
  }
  if (me.mustEnrollTotp) {
    const e = await c.api('POST', '/api/v1/auth/totp/enroll', {});
    if (e.status !== 200) throw new Error(`totp enroll ${acc.username}: ${e.status}`);
    acc.totpSecret = e.json.secretBase32;
    const r = await c.api('POST', '/api/v1/auth/totp/confirm', { code: totp(acc.totpSecret) });
    if (r.status !== 200) throw new Error(`totp confirm ${acc.username}: ${r.status} ${r.text.slice(0, 200)}`);
  }
}

const existing = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { local: {} };
const kcPassword = process.env.KC_USER_PASSWORD;
if (!kcPassword) { console.error('KC_USER_PASSWORD missing: source .env first'); process.exit(1); }

const admin = await oidcLogin('admin1', kcPassword);
const users = (await admin.api('GET', '/api/v1/admin/users')).json;
const list = Array.isArray(users) ? users : users?.users ?? [];
const wanted = [['qa-viewer', 'viewer'], ['qa-operator', 'operator'], ['qa-admin', 'admin'], ['qa-admin2', 'admin']];
const out = { baseUrl: BASE, keycloak: { url: 'http://localhost:8089', passwordEnv: 'KC_USER_PASSWORD', users: { viewer1: 'viewer', operator1: 'operator', admin1: 'admin', nogroup1: 'refused (no group)' } }, local: {} };

for (const [username, role] of wanted) {
  const prev = existing.local?.[username];
  if (prev && (await localLogin(prev))) { out.local[username] = prev; console.log(`ok       ${username} (${role})`); continue; }
  const found = list.find((u) => u.username === username);
  const initialPassword = newPassword();
  if (found) {
    const r = await admin.api('PATCH', `/api/v1/admin/users/${found.id}`, { newPassword: initialPassword, resetTotp: true, disabled: false, role });
    if (r.status >= 300) throw new Error(`reset ${username}: ${r.status} ${r.text.slice(0, 200)}`);
  } else {
    const r = await admin.api('POST', '/api/v1/admin/users', { username, displayName: `QA ${role}${username.endsWith('2') ? ' 2' : ''}`, role, initialPassword });
    if (r.status >= 300) throw new Error(`create ${username}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  const acc = { username, password: initialPassword, role };
  await onboard(acc);
  out.local[username] = acc;
  console.log(`created  ${username} (${role})`);
}

mkdirSync(path.dirname(FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
chmodSync(FILE, 0o600);
console.log(`wrote ${path.relative(ROOT, FILE)} (mode 600). TOTP code: node scripts/qa-accounts.mjs --totp qa-admin`);
