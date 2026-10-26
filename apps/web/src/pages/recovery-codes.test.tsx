/**
 * Recovery codes in the browser: shown once after enrollment (copy, local download), the forced enrollment stays
 * on the codes until the user confirms saving them, Account shows how many are left (warning when low) and
 * regenerates them, and the sign-in TOTP step accepts a recovery code.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { Me } from '@rconsole/shared';
import { SessionContext } from '../lib/context.tsx';
import { Account, Login, recoveryCodesText } from './Auth.tsx';

const CODES = Array.from({ length: 10 }, (_, i) => `ab${i}d-efgh-jk${i}m`);
const me = (over: Partial<Me> = {}): Me => ({
  id: 'local:1', username: 'alice', displayName: 'Alice', source: 'local', role: 'admin', csrfToken: 'csrf',
  totpEnabled: false, mustChangePassword: false, mustEnrollTotp: false, sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(), ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body: unknown };
function stubFetch(route: (c: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return route(c);
  }));
  return calls;
}

function renderAccount(m: Me, opts: { forced?: boolean; refresh?: () => Promise<unknown> } = {}) {
  const refresh = vi.fn(opts.refresh ?? (async () => {}));
  render(
    <SessionContext value={{ me: m, refresh, logout: async () => {} }}>
      <Account forced={opts.forced} />
    </SessionContext>,
  );
  return refresh;
}

afterEach(() => vi.unstubAllGlobals());

it('forced enrollment shows the codes once, copies and downloads them locally, and leaves only when saved', async () => {
  const calls = stubFetch((c) => {
    if (c.url.endsWith('/auth/totp/enroll')) return json({ otpauthUrl: 'otpauth://totp/Redis%20Console:alice?secret=JBSWY3DPEHPK3PXP', secretBase32: 'JBSWY3DPEHPK3PXP' });
    if (c.url.endsWith('/auth/totp/confirm')) return json({ me: me({ totpEnabled: true, recoveryCodesRemaining: 10, csrfToken: 'rotated' }), recoveryCodes: CODES });
    throw new Error(`unexpected ${c.url}`);
  });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const blobs: Blob[] = [];
  const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (blobs.push(b), 'blob:opaque')), revokeObjectURL: revoke }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const refresh = renderAccount(me({ mustEnrollTotp: true }), { forced: true });

  fireEvent.click(await screen.findByTestId('totp-enroll'));
  fireEvent.change(await screen.findByTestId('totp-enroll-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('totp-enroll-confirm'));
  const panel = await screen.findByTestId('recovery-codes');
  const items = within(panel).getAllByRole('listitem').map((li) => li.textContent);
  expect(items).toEqual(CODES);
  // Not reloaded yet: the forced page would close and take the codes with it. It already says TOTP is on.
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByTestId('totp-state').textContent).toBe('on');
  expect(calls.find((c) => c.url.endsWith('/auth/totp/confirm'))?.body).toEqual({ code: '123456' });

  fireEvent.click(within(panel).getByRole('button', { name: 'Copy codes' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join('\n')));

  fireEvent.click(screen.getByTestId('recovery-download'));
  expect(blobs).toHaveLength(1);
  expect(blobs[0]!.type).toBe('text/plain');
  const text = await blobs[0]!.text();
  for (const code of CODES) expect(text).toContain(code);
  expect(text).toContain('Redis Console recovery codes for alice');
  const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
  expect(anchor.download).toBe('redis-console-recovery-codes.txt');
  expect(anchor.href).toBe('blob:opaque');
  // Nothing was sent anywhere: only the two API calls of the enrollment.
  expect(calls.map((c) => c.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/auth/totp/enroll', '/auth/totp/confirm']);

  fireEvent.click(screen.getByTestId('recovery-saved'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId('recovery-codes')).toBeNull());
  click.mockRestore();
});

it('account shows the remaining count, warns when low, and regenerates with the password', async () => {
  const calls = stubFetch((c) => {
    if (c.url.endsWith('/auth/recovery-codes')) return json({ recoveryCodes: CODES, me: me({ totpEnabled: true, recoveryCodesRemaining: 10 }) });
    throw new Error(`unexpected ${c.url}`);
  });
  const refresh = renderAccount(me({ totpEnabled: true, recoveryCodesRemaining: 2 }));
  expect(screen.getByTestId('recovery-remaining').textContent).toBe('2 of 10 left');
  expect(screen.getByTestId('recovery-low').textContent).toContain('Only 2 recovery codes left');
  fireEvent.change(screen.getByTestId('recovery-password'), { target: { value: 'correct horse battery staple' } });
  fireEvent.click(screen.getByTestId('recovery-regenerate'));
  const panel = await screen.findByTestId('recovery-codes');
  expect(within(panel).getAllByRole('listitem')).toHaveLength(10);
  expect(screen.getByTestId('recovery-remaining').textContent).toBe('10 of 10 left');
  expect(calls[0]!.body).toEqual({ currentPassword: 'correct horse battery staple' });
  expect((screen.queryByTestId('recovery-password') as HTMLInputElement | null)).toBeNull();
  fireEvent.click(screen.getByTestId('recovery-saved'));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it('no warning with plenty of codes; a strong one with none; nothing for SSO accounts', () => {
  renderAccount(me({ totpEnabled: true, recoveryCodesRemaining: 9 }));
  expect(screen.queryByTestId('recovery-low')).toBeNull();
  document.body.innerHTML = '';
  renderAccount(me({ totpEnabled: true, recoveryCodesRemaining: 0 }));
  expect(screen.getByTestId('recovery-low').textContent).toContain('no recovery codes left');
  document.body.innerHTML = '';
  renderAccount(me({ source: 'oidc', totpEnabled: false }));
  expect(screen.queryByTestId('recovery-remaining')).toBeNull();
  expect(screen.queryByTestId('recovery-regenerate')).toBeNull();
});

it('the sign-in TOTP step accepts a recovery code instead', async () => {
  const calls = stubFetch((c) => {
    if (c.url.endsWith('/auth/providers')) return json({ local: { enabled: true }, oidc: { enabled: false, displayName: '' } });
    if (c.url.endsWith('/auth/login')) return json({ totpRequired: true });
    if (c.url.endsWith('/auth/totp/verify')) return json({ me: me({ totpEnabled: true, recoveryCodesRemaining: 9 }) });
    throw new Error(`unexpected ${c.url}`);
  });
  const onLogin = vi.fn(async () => {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/login']}>
        <Login onLogin={onLogin} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByTestId('login-username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByTestId('login-submit'));
  await screen.findByTestId('totp-code');
  fireEvent.click(screen.getByTestId('recovery-toggle'));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Enter a recovery code');
  fireEvent.change(screen.getByTestId('recovery-code'), { target: { value: 'ABCD-EFGH-JKMN' } });
  fireEvent.click(screen.getByTestId('totp-submit'));
  await waitFor(() => expect(onLogin).toHaveBeenCalled());
  expect(calls.find((c) => c.url.endsWith('/auth/totp/verify'))?.body).toEqual({ recoveryCode: 'ABCD-EFGH-JKMN' });
  // Back to the authenticator.
  expect(screen.getByTestId('recovery-toggle').textContent).toBe('Use your authenticator app');
});

it('the downloaded file lists the codes and how they work', () => {
  const text = recoveryCodesText(['a', 'b'], 'bob', new Date('2026-10-24T00:00:00Z'));
  expect(text).toBe('Redis Console recovery codes for bob\nGenerated 2026-10-24T00:00:00.000Z\n\na\nb\n\nEach code works once, in place of an authenticator code at sign-in.\nGenerating new codes in Account makes these stop working.\n');
});

// v0.3 follow-up 2: Account → About links the shipped third-party notices (a static same-origin file, new tab).
it('Account has an About section linking the third-party notices; the forced page does not', () => {
  renderAccount(me({ totpEnabled: true, recoveryCodesRemaining: 10 }));
  const link = within(screen.getByTestId('account-about')).getByTestId('about-notices');
  expect(link).toHaveAttribute('href', '/THIRD-PARTY-NOTICES.txt');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByTestId('account-about')).toHaveTextContent('Apache License 2.0');
});
it('the forced account page has no About section', () => {
  renderAccount(me({ mustChangePassword: true }), { forced: true });
  expect(screen.queryByTestId('account-about')).toBeNull();
});
