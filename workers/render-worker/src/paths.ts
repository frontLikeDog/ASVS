import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** workers/render-worker */
export const workerRoot = path.resolve(here, '..');
export const workspaceRoot = path.resolve(workerRoot, '../..');
export const renderEntry = path.join(workspaceRoot, 'libs/render/src/entry.tsx');
export const defaultFixture = path.join(workerRoot, 'fixtures/golden-30s.json');
export const defaultOutDir = path.join(workspaceRoot, 'dist/render-worker/golden-30s');
