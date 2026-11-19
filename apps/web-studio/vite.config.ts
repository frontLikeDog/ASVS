import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, '../..');

const alias = {
  '@asvs/domain': path.join(workspaceRoot, 'libs/domain/src/index.ts'),
  '@asvs/mock-data': path.join(workspaceRoot, 'libs/mock-data/src/index.ts'),
  '@asvs/mock-services': path.join(workspaceRoot, 'libs/mock-services/src/index.ts'),
  '@asvs/state': path.join(workspaceRoot, 'libs/state/src/index.ts'),
  '@asvs/ui': path.join(workspaceRoot, 'libs/ui/src/index.ts'),
  '@asvs/features-project': path.join(workspaceRoot, 'libs/features/project-hub/src/index.ts'),
  '@asvs/features-video': path.join(workspaceRoot, 'libs/features/video-studio/src/index.ts'),
  '@asvs/features-production': path.join(workspaceRoot, 'libs/features/production-suite/src/index.ts'),
};

export default defineConfig({
  root: appRoot,
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  server: {
    host: 'localhost',
    port: 4200,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 4200,
    strictPort: true,
  },
  build: {
    outDir: path.join(workspaceRoot, 'dist/apps/web-studio'),
    emptyOutDir: true,
  },
});
