/** Security headers applied to every response (including SSE and static files). */
import { randomBytes } from 'node:crypto';

export const newNonce = () => randomBytes(18).toString('base64');

export function csp(nonce: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
  ].join('; ');
}

const PERMISSIONS_POLICY = [
  'accelerometer', 'autoplay', 'camera', 'clipboard-read', 'display-capture', 'encrypted-media', 'fullscreen', 'geolocation',
  'gyroscope', 'hid', 'idle-detection', 'magnetometer', 'microphone', 'midi', 'payment', 'picture-in-picture',
  'publickey-credentials-get', 'screen-wake-lock', 'serial', 'usb', 'xr-spatial-tracking',
].map((f) => `${f}=()`).join(', ');

export function securityHeaders(nonce: string, opts: { hsts: boolean; api: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    'content-security-policy': csp(nonce),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'x-frame-options': 'DENY',
    'origin-agent-cluster': '?1',
    'x-dns-prefetch-control': 'off',
    'x-permitted-cross-domain-policies': 'none',
  };
  if (opts.hsts) h['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
  if (opts.api) {
    h['cache-control'] = 'no-store';
    h.pragma = 'no-cache';
  }
  return h;
}
