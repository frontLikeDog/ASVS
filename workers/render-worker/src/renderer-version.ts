import { readFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './paths';

export function rendererVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(path.join(workspaceRoot, 'node_modules/remotion/package.json'), 'utf8'),
  ) as { version?: string };
  if (!packageJson.version) throw new Error('无法读取 remotion 版本');
  return packageJson.version;
}
