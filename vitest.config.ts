import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@asvs/domain': path.join(root, 'libs/domain/src/index.ts'),
      '@asvs/render': path.join(root, 'libs/render/src/index.ts'),
      '@asvs/mock-data': path.join(root, 'libs/mock-data/src/index.ts'),
      '@asvs/mock-services': path.join(root, 'libs/mock-services/src/index.ts'),
      '@asvs/state': path.join(root, 'libs/state/src/index.ts'),
      '@asvs/ui': path.join(root, 'libs/ui/src/index.ts'),
      '@asvs/features-project': path.join(root, 'libs/features/project-hub/src/index.ts'),
      '@asvs/features-video': path.join(root, 'libs/features/video-studio/src/index.ts'),
      '@asvs/features-production': path.join(root, 'libs/features/production-suite/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['libs/**/*.test.ts', 'libs/**/*.test.tsx', 'workers/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    css: false,
    testTimeout: 15000,
  },
});
