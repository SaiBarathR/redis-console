import { expect } from 'vitest';
import type { Client } from '../helpers.ts';

export type Res = Awaited<ReturnType<Client['req']>>;

/** Send a request expecting 428, then resubmit with the challenge token (+ typed / reason). */
export async function confirmed(c: Client, url: string, body: Record<string, unknown>, extra: { typed?: string; reason?: string } = {}): Promise<{ first: Res; second: Res }> {
  const first = await c.req('POST', url, body);
  expect(first.status, JSON.stringify(first.json)).toBe(428);
  expect(first.json.error.code).toBe('confirmation_required');
  const ch = first.json.error.confirmation;
  const confirmation: Record<string, string> = { token: ch.token };
  if (ch.level === 'typed') confirmation.typed = extra.typed ?? ch.expectedText;
  if (extra.reason ?? (ch.reasonRequired ? 'integration test reason' : undefined)) confirmation.reason = extra.reason ?? 'integration test reason';
  const second = await c.req('POST', url, { ...body, confirmation });
  return { first, second };
}

export const cli = (c: Client, db: string, line: string) => c.req('POST', `/api/v1/databases/${db}/cli`, { line });

/** Unwrap a utf8 'str' reply. */
export function str(reply: any): string {
  expect(reply.t).toBe('str');
  return reply.v.enc === 'utf8' ? reply.v.data : Buffer.from(reply.v.data, 'base64').toString('latin1');
}
