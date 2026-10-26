// The old local alias expansion no longer exists. Exercise the same 30-step request through the API.
process.argv[2]='30';
await import('./apply-live.mjs');
