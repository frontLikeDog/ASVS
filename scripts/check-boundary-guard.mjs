#!/usr/bin/env node
/**
 * Proves that `@nx/enforce-module-boundaries` actually rejects cross-layer
 * imports instead of being configured-but-inert.
 *
 * For every case below a probe file is written into a real library source
 * directory, ESLint is run against that single file, and the result is
 * inverted: the guard passes only when ESLint fails with the module-boundary
 * rule. The probe files are always removed again, including on failure.
 *
 * Why invert the exit code: the failure we want is the rule firing. If someone
 * deletes the rule, mistags a project, or the layer constraints drift, this
 * script goes red — the normal `lint` target would stay green.
 *
 * Usage: node scripts/check-boundary-guard.mjs [--verbose]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

/**
 * Each case is a deliberately illegal import. `from` must be a project whose
 * tag constraints forbid `imports`; the probe lives inside that project's
 * sourceRoot so Nx attributes it to the right project.
 */
const CASES = [
  {
    id: 'domain->state',
    probe: 'libs/domain/src/__boundary_probe__.ts',
    reason: 'type:domain may depend on nothing',
    source: "import { useStudioStore } from '@asvs/state';\nexport const probe = useStudioStore;\n",
  },
  {
    id: 'ui->state',
    probe: 'libs/ui/src/__boundary_probe__.ts',
    reason: 'type:ui may only depend on type:domain',
    source: "import { useStudioStore } from '@asvs/state';\nexport const probe = useStudioStore;\n",
  },
  {
    id: 'api->state',
    probe: 'apps/api/src/__boundary_probe__.ts',
    reason: 'type:api may only depend on domain, ports and adapters',
    source: "import { useStudioStore } from '@asvs/state';\nexport const probe = useStudioStore;\n",
  },
  {
    id: 'feature->mock-services',
    probe: 'libs/features/project-hub/src/__boundary_probe__.ts',
    reason: 'type:feature may not reach the service layer',
    source: "import { directorService } from '@asvs/mock-services';\nexport const probe = directorService;\n",
  },
];

function cleanup() {
  for (const testCase of CASES) {
    const probePath = path.join(workspaceRoot, testCase.probe);
    if (existsSync(probePath)) rmSync(probePath, { force: true });
  }
}

function runEslint(probePath) {
  const result = spawnSync(
    process.execPath,
    [path.join(workspaceRoot, 'node_modules/eslint/bin/eslint.js'), path.relative(workspaceRoot, probePath)],
    { cwd: workspaceRoot, encoding: 'utf8', shell: false },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error,
  };
}

function main() {
  // A crashed previous run may have left a probe behind, which would make the
  // real lint target fail for everyone. Remove stale probes before starting.
  cleanup();

  const failures = [];
  console.log('\nBoundary guard · @nx/enforce-module-boundaries');
  console.log('─'.repeat(64));

  for (const testCase of CASES) {
    const probePath = path.join(workspaceRoot, testCase.probe);
    writeFileSync(probePath, testCase.source, 'utf8');

    let result;
    try {
      result = runEslint(probePath);
    } finally {
      cleanup();
    }

    if (result.error) {
      failures.push(`${testCase.id}: could not run ESLint — ${result.error.message}`);
      console.log(`✗ ${testCase.id.padEnd(24)} ESLint did not run`);
      continue;
    }

    const ruleFired = result.output.includes('@nx/enforce-module-boundaries');
    const rejected = result.status !== 0 && ruleFired;

    if (verbose && !rejected) console.log(result.output);

    if (rejected) {
      console.log(`✓ ${testCase.id.padEnd(24)} rejected as expected (${testCase.reason})`);
    } else {
      const detail = ruleFired
        ? 'rule reported but ESLint exited 0'
        : 'ESLint accepted the illegal import — the module boundary rule is not enforcing anything';
      failures.push(`${testCase.id}: ${detail}`);
      console.log(`✗ ${testCase.id.padEnd(24)} NOT rejected — ${detail}`);
    }
  }

  console.log('─'.repeat(64));

  if (failures.length > 0) {
    console.error('\nBoundary guard failed:\n');
    for (const failure of failures) console.error(`  • ${failure}`);
    console.error('\nThis check expects ESLint to REJECT the probe imports. A green result means');
    console.error('the layer constraints stopped working, not that the code improved.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`All ${CASES.length} cross-layer probes were rejected as expected.\n`);
}

main();
