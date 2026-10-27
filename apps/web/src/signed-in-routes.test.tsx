import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.tsx';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const me = {
  id: 'u1', username: 'alice', displayName: 'Alice', source: 'local', role: 'admin', csrfToken: 'csrf-token-0123456789',
  totpEnabled: true, mustChangePassword: false, mustEnrollTotp: false,
  sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const database = {
  id: 'sandbox', name: 'Sandbox', environment: 'dev', readOnly: false, effectiveRole: 'admin',
  features: { profiler: true }, status: 'connected', db: 0,
};

// Deployment trial: after signing in on /login, the address bar kept /login while the Databases page showed. Any path
// the shell has no view for now goes to the database picker's own address.
it.each(['/login', '/login?error=oidc_state', '/no-such-view'])('a signed-in visit to %s lands on /', async (path) => {
  window.history.replaceState(null, '', path);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return json(me);
    if (url.endsWith('/databases')) return json({ databases: [database] });
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  }));
  render(<App />);
  await screen.findByTestId('database-landing');
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/'));
});

