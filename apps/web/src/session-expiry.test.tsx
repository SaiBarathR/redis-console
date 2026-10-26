import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.tsx';
import { endSession } from './lib/api.ts';

afterEach(() => vi.unstubAllGlobals());
it('concurrent expiry notifications leave sign-in methods usable', async () => {
  window.history.replaceState(null, '', '/login');
  const pending: (() => void)[] = [];
  let providers = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Not signed in.' } }), { status: 401 });
    if (url.endsWith('/auth/providers')) {
      providers++;
      if (providers > 1) await new Promise<void>(resolve => pending.push(resolve));
      return new Response(JSON.stringify({ local: { enabled: true }, oidc: { enabled: false } }));
    }
    throw new Error('Unexpected request');
  }));
  render(<App />);
  await screen.findByTestId('login-username');
  act(() => endSession('Session expired.'));
  await waitFor(() => expect(providers).toBeGreaterThan(1));
  await screen.findByTestId('session-ended');
  act(() => endSession('Not signed in.'));
  expect(providers).toBe(2);
  await act(async () => { for (const resolve of pending) resolve(); });
  await waitFor(() => expect(screen.getByTestId('login-username')).toBeVisible());
});
