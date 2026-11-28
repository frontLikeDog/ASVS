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
  { find: '@asvs/ports', replacement: path.join(workspaceRoot, 'libs/ports/src/index.ts') },
  {
    find: '@asvs/adapters-http',
    replacement: path.join(workspaceRoot, 'libs/adapters-http/src/index.ts'),
  },
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

// Keep browser calls same-origin: the outer capture allowlist only trusts
// http://localhost:4200, and this avoids a CORS precondition in dev.
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:4300',
    changeOrigin: true,
    rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  root: appRoot,
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  server: {
    host: 'localhost',
    port: 4200,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: 'localhost',
    port: 4200,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: path.join(workspaceRoot, 'dist/apps/web-studio'),
    emptyOutDir: true,
    // The bundle budget check (scripts/check-bundle-budget.mjs) needs the
    // manifest to map route chunks and their static import closures.
    manifest: true,
    rollupOptions: {
      treeshake: {
        /**
         * docs/16 red line 1: the full `QaReportV1` schema must never enter the
         * initial chunk. `libs/domain/src/qa.ts` is re-exported from the
         * `@asvs/domain` barrel and builds ~20 zod schemas at module top level;
         * Rollup cannot prove those `z.object(...)` calls pure, so without this
         * declaration it keeps the whole module whenever anything imports the
         * barrel. Declaring only that module side-effect-free lets Rollup drop
         * it for consumers that use nothing from it, while the API — which
         * imports `qaReportV1Schema` for real — is unaffected.
         *
         * This is deliberately narrow: we do not mark the whole domain lib
         * side-effect-free, because `defaults.ts` / `mock` seeds may rely on
         * module evaluation order.
         */
        moduleSideEffects(id: string) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.endsWith('/libs/domain/src/qa.ts')) return false;
          return true;
        },
      },
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
