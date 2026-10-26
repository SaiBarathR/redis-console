/**
 * Post-execution redaction of console replies. The browser must never receive Redis credentials, and the
 * console should not reveal more about the server than the overview page does:
 * - CONFIG GET: password parameters (requirepass, masterauth, TLS key passphrases) are replaced.
 * - INFO: file paths, run ids and other hosts' addresses are removed (same rules as the overview).
 * - For non-admins, network addresses are hidden as well: `addr`/`laddr` in CLIENT LIST/INFO, INFO `listener*`
 *   bind addresses and ports, and IP literals / hostnames in CLUSTER NODES|SLOTS|SHARDS and ROLE replies.
 */
import type { Reply } from '@rconsole/shared';
import { HIDDEN_INFO_FIELDS } from '../routes/infoFields.ts';

export const REDACTED = '<redacted>';

/** CONFIG parameters that hold secrets (exact names, lower-case). */
const SECRET_CONFIG = new Set(['requirepass', 'masterauth', 'tls-key-file-pass', 'tls-client-key-file-pass', 'sentinel-pass', 'auth-pass']);

export function isSecretConfig(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_CONFIG.has(n) || /(^|-)(pass|password|passphrase|secret)$/.test(n);
}

const strOf = (r: Reply): string | undefined => (r.t === 'str' ? (r.v.enc === 'utf8' ? r.v.data : Buffer.from(r.v.data, 'base64').toString('latin1')) : undefined);
const redacted = (): Reply => ({ t: 'str', v: { enc: 'utf8', data: REDACTED } });

export const HIDDEN = '<hidden>';

/** INFO `listenerN` value (`name=tcp,bind=*,bind=-::*,port=6379`) with bind addresses and port hidden. */
export function maskListener(v: string): string {
  return v.replace(/bind=[^,\r]*/g, `bind=${HIDDEN}`).replace(/port=\d+/g, `port=${HIDDEN}`);
}

/** Remove hidden INFO fields from INFO text; mask replica addresses (and, with hideAddresses, listeners). */
export function sanitizeInfoText(text: string, hideAddresses = false): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    const key = i > 0 ? line.slice(0, i) : '';
    if (key && HIDDEN_INFO_FIELDS.has(key)) continue;
    if (/^(slave|replica)\d+$/.test(key)) out.push(line.replace(/ip=[^,]*/g, `ip=${HIDDEN}`).replace(/port=\d+/g, `port=${HIDDEN}`));
    else if (hideAddresses && /^listener\d+$/.test(key)) out.push(`${key}:${maskListener(line.slice(i + 1))}`);
    else out.push(line);
  }
  return out.join('\n');
}

/** CLIENT LIST / CLIENT INFO text with `addr=` and `laddr=` hidden. */
export function maskClientAddrs(text: string): string {
  return text.replace(/(^|\s)(l?addr)=\S*/g, `$1$2=${HIDDEN}`);
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// IPv6 literals: at least two colons among hex groups (bounded length; no nested quantifiers).
const IPV6 = /(?<![\w:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])/g;
/** Mask IP literals in free text. */
export function maskIps(text: string): string {
  return text.replace(IPV4, HIDDEN).replace(IPV6, HIDDEN);
}

/** CLUSTER NODES line: `<id> <ip:port@cport[,hostname]> <flags> ...` -> address field hidden. */
function maskClusterNodes(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const parts = line.split(' ');
      if (parts.length > 2) parts[1] = HIDDEN;
      return maskIps(parts.join(' '));
    })
    .join('\n');
}

const ADDRESS_FIELDS = new Set(['ip', 'endpoint', 'hostname']);

/** Walk a reply tree: string leaves are IP-masked; map values under ip/endpoint/hostname are hidden. */
function maskTree(r: Reply, depth = 0): Reply {
  if (depth > 16) return r;
  const hidden = (): Reply => ({ t: 'str', v: { enc: 'utf8', data: HIDDEN } });
  switch (r.t) {
    case 'str':
      return r.v.enc === 'utf8' ? { t: 'str', v: { enc: 'utf8', data: maskIps(r.v.data) } } : r;
    case 'arr':
    case 'set':
      return { ...r, v: r.v.map((x) => maskTree(x, depth + 1)) };
    case 'map':
      return { ...r, v: r.v.map(([k, v]) => [k, ADDRESS_FIELDS.has((strOf(k) ?? '').toLowerCase()) ? hidden() : maskTree(v, depth + 1)] as [Reply, Reply]) };
    default:
      return r;
  }
}

/** SLOWLOG GET entries are [id, time, micros, argv, client "ip:port", client name]: the client address is hidden. */
function maskSlowlogClients(reply: Reply): Reply {
  if (reply.t !== 'arr') return reply;
  return {
    ...reply,
    v: reply.v.map((e) => (e.t === 'arr' && e.v.length > 4 ? { ...e, v: e.v.map((x, i) => (i === 4 ? hiddenStr() : x)) } : e)),
  };
}
const hiddenStr = (): Reply => ({ t: 'str', v: { enc: 'utf8', data: HIDDEN } });

const mapStr = (r: Reply, f: (s: string) => string): Reply => (r.t === 'str' && r.v.enc === 'utf8' ? { t: 'str', v: { enc: 'utf8', data: f(r.v.data) } } : r);

export interface RedactOptions {
  /** Hide network addresses (non-admin callers). */
  hideAddresses?: boolean;
}

export function redactReply(command: string, subcommand: string | undefined, reply: Reply, opts: RedactOptions = {}): Reply {
  if (opts.hideAddresses) {
    if (command === 'CLIENT' && (subcommand === 'LIST' || subcommand === 'INFO')) return mapStr(reply, maskClientAddrs);
    if (command === 'CLUSTER' && subcommand === 'NODES') return mapStr(reply, maskClusterNodes);
    if (command === 'SLOWLOG' && subcommand === 'GET') return maskSlowlogClients(reply);
    if ((command === 'CLUSTER' && (subcommand === 'SLOTS' || subcommand === 'SHARDS' || subcommand === 'REPLICAS' || subcommand === 'SLAVES')) || command === 'ROLE') return maskTree(reply);
  }
  if (command === 'CONFIG' && subcommand === 'GET') {
    if (reply.t === 'map') return { ...reply, v: reply.v.map(([k, v]) => [k, isSecretConfig(strOf(k) ?? '') ? redacted() : v] as [Reply, Reply]) };
    if (reply.t === 'arr') {
      // RESP2-style flat [name, value, ...]
      return { ...reply, v: reply.v.map((x, i) => (i % 2 === 1 && isSecretConfig(strOf(reply.v[i - 1]!) ?? '') ? redacted() : x)) };
    }
  }
  if (command === 'INFO' && reply.t === 'str' && reply.v.enc === 'utf8') {
    return { t: 'str', v: { enc: 'utf8', data: sanitizeInfoText(reply.v.data, !!opts.hideAddresses) } };
  }
  return reply;
}
