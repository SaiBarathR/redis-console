import { render, screen } from '@testing-library/react';
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

// Deployment trial: a Valkey 8.1 server was listed as "7.2.4", the Redis version it reports for compatibility.
it('the database picker names Valkey with its own version', async () => {
  window.history.replaceState(null, '', '/');
  const valkey = { ...database, id: 'queue', name: 'Queue', server: { version: '7.2.4', engine: { name: 'Valkey', version: '8.1.4' }, mode: 'standalone', modules: [] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) return json(me);
    if (url.endsWith('/databases')) return json({ databases: [valkey] });
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  }));
  render(<App />);
  const cell = await screen.findByText('Valkey 8.1.4');
  expect(cell).toHaveAttribute('title', 'Reports Redis 7.2.4 for compatibility');
});
