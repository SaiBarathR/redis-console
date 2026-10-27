import { describe, expect, it } from 'vitest';
import { serverEngine } from '../../src/redis/engine.ts';

// Deployment trial: a Valkey 8.1 server was listed as "7.2.4", the Redis version it reports for compatibility.
describe('serverEngine', () => {
  it('names Valkey and its own version', () => {
    expect(serverEngine({ server: { redis_version: '7.2.4', server_name: 'valkey', valkey_version: '8.1.4' } })).toEqual({ name: 'Valkey', version: '8.1.4' });
  });
  it('is absent for Redis, with or without server_name', () => {
    expect(serverEngine({ server: { redis_version: '8.10.2' } })).toBeUndefined();
    expect(serverEngine({ server: { redis_version: '8.10.2', server_name: 'redis' } })).toBeUndefined();
    expect(serverEngine({})).toBeUndefined();
  });
  it('keeps another engine readable and bounded, falling back to the compatibility version', () => {
    expect(serverEngine({ server: { redis_version: '7.0.0', server_name: 'some-db' } })).toEqual({ name: 'some-db', version: '7.0.0' });
    const long = serverEngine({ server: { redis_version: '7', server_name: 'x'.repeat(200), ['x'.repeat(200) + '_version']: '1'.repeat(200) } });
    expect(long!.name.length).toBeLessThanOrEqual(32);
    expect(long!.version.length).toBeLessThanOrEqual(32);
  });
});
