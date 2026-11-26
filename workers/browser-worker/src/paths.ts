import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** workers/browser-worker */
export const workerRoot = path.resolve(here, '..');
export const workspaceRoot = path.resolve(workerRoot, '../..');

export const plansRoot = path.join(workerRoot, 'plans');
export const defaultPlan = path.join(plansRoot, 'web-studio-tour.yaml');
export const blockedOriginPlan = path.join(plansRoot, 'blocked-origin.yaml');

export const defaultOutDir = path.join(workspaceRoot, 'dist/browser-worker/web-studio-tour');
export const repeatOutDir = path.join(workspaceRoot, 'dist/browser-worker/repeat');

export const webStudioRoot = path.join(workspaceRoot, 'apps/web-studio');
/** Vite build output for web-studio; served by `vite preview` during capture. */
export const webStudioDist = path.join(workspaceRoot, 'dist/apps/web-studio');
export const viteBin = path.join(workspaceRoot, 'node_modules/vite/bin/vite.js');

/** Workspace-relative POSIX path, used in receipts/manifests. */
export function storageRefFor(file: string): string {
  return path.relative(workspaceRoot, file).split(path.sep).join('/');
}

export function resolveFromWorkspace(file: string): string {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}
