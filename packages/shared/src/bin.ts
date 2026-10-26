import type { Bin } from './api.ts';

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Encode raw bytes as Bin: utf8 when valid UTF-8, else base64. */
export function binFromBytes(bytes: Uint8Array): Bin {
  try {
    return { enc: 'utf8', data: utf8Fatal.decode(bytes) };
  } catch {
    return { enc: 'base64', data: toBase64(bytes) };
  }
}

export function binFromString(s: string): Bin {
  return { enc: 'utf8', data: s };
}

export function bytesFromBin(b: Bin): Uint8Array {
  return b.enc === 'utf8' ? utf8.encode(b.data) : fromBase64(b.data);
}

/** Display text for a Bin (base64 shown with a marker). Never use as HTML. */
export function binToDisplay(b: Bin): string {
  return b.enc === 'utf8' ? b.data : `<binary base64:${b.data}>`;
}

/** URL-safe base64 (no padding) of raw key bytes — used for the `k` query param. */
export function keyToParam(b: Bin): string {
  return toBase64(bytesFromBin(b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function keyFromParam(p: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(p)) throw new Error('invalid key parameter');
  const b64 = p.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((p.length + 3) % 4);
  return fromBase64(b64);
}

export function binEquals(a: Bin, b: Bin): boolean {
  const x = bytesFromBin(a), y = bytesFromBin(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
