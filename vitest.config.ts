import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Editing tests build full hairstyles and apply dozens of strokes.
    testTimeout: 120_000,
  },
});
