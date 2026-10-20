import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lkt/core': pkg('core'),
      '@lkt/db': pkg('db'),
      '@lkt/gtfs': pkg('gtfs'),
      '@lkt/ingest': pkg('ingest'),
      '@lkt/query': pkg('query'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
