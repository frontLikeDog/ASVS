import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads key=value pairs from a local env file (e.g. `apps/api/.env.local`)
 * without overwriting variables already set in `targetEnv`.
 */
export function loadEnvFile(
  filePath: string,
  targetEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (targetEnv[key] !== undefined) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    targetEnv[key] = value;
  }
  return true;
}

export function loadApiLocalEnv(
  apiDir: string,
  targetEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return loadEnvFile(path.join(apiDir, '.env.local'), targetEnv);
}
