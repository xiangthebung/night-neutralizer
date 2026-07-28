import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default environment is node; DOM-dependent suites opt in with
    // `// @vitest-environment jsdom` at the top of the file.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    clearMocks: true,
  },
});
