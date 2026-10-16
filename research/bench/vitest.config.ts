import { defineConfig } from 'vitest/config';

// Benchmarks are kept out of the normal test run: npx vitest run --config research/bench/vitest.config.ts
export default defineConfig({
  test: { include: ['research/bench/**/*.test.ts'], environment: 'node', testTimeout: 300_000 },
});
