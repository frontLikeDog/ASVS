import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, '../..');

const alias = [
  // Subpath entries must come first: the barrel aliases below also prefix-match
  // `@asvs/features-*/…` and would otherwise swallow the page module path.
  {
    find: /^@asvs\/features-project\/(.+)$/,
    replacement: path.join(workspaceRoot, 'libs/features/project-hub/src/$1'),
  },
  {
    find: /^@asvs\/features-video\/(.+)$/,
    replacement: path.join(workspaceRoot, 'libs/features/video-studio/src/$1'),
  },
  {
    find: /^@asvs\/features-production\/(.+)$/,
    replacement: path.join(workspaceRoot, 'libs/features/production-suite/src/$1'),
  },
  { find: '@asvs/domain', replacement: path.join(workspaceRoot, 'libs/domain/src/index.ts') },
  { find: '@asvs/mock-data', replacement: path.join(workspaceRoot, 'libs/mock-data/src/index.ts') },
  {
    find: '@asvs/mock-services',
    replacement: path.join(workspaceRoot, 'libs/mock-services/src/index.ts'),
  },
  { find: '@asvs/state', replacement: path.join(workspaceRoot, 'libs/state/src/index.ts') },
  { find: '@asvs/ui', replacement: path.join(workspaceRoot, 'libs/ui/src/index.ts') },
  {
    find: '@asvs/features-project',
    replacement: path.join(workspaceRoot, 'libs/features/project-hub/src/index.ts'),
  },
  {
    find: '@asvs/features-video',
    replacement: path.join(workspaceRoot, 'libs/features/video-studio/src/index.ts'),
  },
  {
    find: '@asvs/features-production',
    replacement: path.join(workspaceRoot, 'libs/features/production-suite/src/index.ts'),
  },
];

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
    // The bundle budget check (scripts/check-bundle-budget.mjs) needs the
    // manifest to map route chunks and their static import closures.
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          const packagePath = normalized.slice(
            normalized.lastIndexOf('/node_modules/') + '/node_modules/'.length,
          );
          if (
            /^(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(
              packagePath,
            )
          ) {
            return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
});
