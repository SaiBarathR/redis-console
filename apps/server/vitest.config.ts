import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration files share the sandbox Redis (with per-file key prefixes) and port 4100 (OIDC).
    fileParallelism: false,
    reporters: ['default'],
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
