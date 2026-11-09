import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/dist/**', '**/node_modules/**', '.temp/**', '.git/**'],
    environment: 'node',
    // Default timeout for e2e tests (LLM calls can be slow)
    testTimeout: 90_000,
    pool: 'forks',
  },
});
