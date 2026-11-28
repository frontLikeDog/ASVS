#!/usr/bin/env node
/**
 * Enforces bundle budgets from bundle-budget.json against the production build.
 *
 * Reads the Vite manifest so route chunks are identified by source page, not by
 * hashed file name. "Initial" is the entry chunk plus its static import closure.
 * A route's budget covers the extra JS needed when that route is loaded first
 * (initial closure excluded). Any single chunk is also capped.
 *
 * Usage: node scripts/check-bundle-budget.mjs [--dist <dir>] [--config <file>]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');

function readArgs(argv) {
  const args = { dist: path.join(workspaceRoot, 'dist/apps/web-studio'), config: path.join(workspaceRoot, 'bundle-budget.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dist' && argv[index + 1]) {
      args.dist = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--config' && argv[index + 1]) {
      args.config = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

const KiB = 1024;
const toKb = (bytes) => Math.round((bytes / KiB) * 10) / 10;
const normalize = (value) => value.replace(/\\/g, '/');

async function main() {
  const { dist, config: configPath } = readArgs(process.argv.slice(2));
  const manifestPath = path.join(dist, '.vite/manifest.json');
  const budget = JSON.parse(await readFile(configPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const sizeCache = new Map();
  async function fileSize(file) {
    if (!sizeCache.has(file)) {
      const buffer = await readFile(path.join(dist, file));
      sizeCache.set(file, { raw: buffer.byteLength, gzip: gzipSync(buffer, { level: 9 }).byteLength });
    }
    return sizeCache.get(file);
  }

  const entries = Object.entries(manifest);
  // A dynamic entry keyed by source (`…/production-page.tsx`) is preferred;
  // when Rollup merges entries it re-keys the chunk as `_production-page-*.js`
  // and drops `src`. That merged form still counts as the route's chunk as
  // long as the initial entry reaches it through a dynamic import — otherwise
  // the route would be loaded eagerly, which the check must catch.
  const findRoute = (pageFile) => {
    const stem = pageFile.replace(/\.tsx?$/, '');
    const bySource = entries.find(
      ([key, entry]) =>
        normalize(key).endsWith(`/${pageFile}`) || normalize(entry.src ?? '').endsWith(`/${pageFile}`),
    );
    if (bySource) return bySource;
    return entries.find(
      ([key, entry]) =>
        entry.isDynamicEntry === true &&
        !entry.src &&
        (normalize(key).endsWith(`/_${stem}-`) || normalize(key).startsWith(`_${stem}-`)),
    );
  };

  function closure(keys) {
    const seen = new Set();
    const visit = (key) => {
      if (seen.has(key)) return;
      const entry = manifest[key];
      if (!entry) return;
      seen.add(key);
      for (const imported of entry.imports ?? []) visit(imported);
    };
    for (const key of keys) visit(key);
    return seen;
  }

  async function measure(keys) {
    let raw = 0;
    let gzip = 0;
    for (const key of keys) {
      const entry = manifest[key];
      for (const file of [entry.file, ...(entry.css ?? [])].filter(Boolean)) {
        const size = await fileSize(file);
        raw += size.raw;
        gzip += size.gzip;
      }
    }
    return { raw, gzip };
  }

  const htmlKey = entries.find(([, entry]) => entry.isEntry && entry.file?.endsWith('.js'))?.[0];
  if (!htmlKey) {
    throw new Error(`No JavaScript entry found in ${manifestPath}`);
  }

  const initialKeys = closure([htmlKey]);
  const initial = await measure(initialKeys);

  const results = [];
  const failures = [];

  const compare = (label, actual, limit) => {
    const ok = actual.gzip <= limit.gzipKb * KiB && actual.raw <= limit.rawKb * KiB;
    results.push({
      label,
      actual,
      limit,
      ok,
    });
    if (!ok) {
      failures.push(
        `${label}: ${toKb(actual.gzip)} kB gzip / ${toKb(actual.raw)} kB raw ` +
          `exceeds ${limit.gzipKb} kB gzip / ${limit.rawKb} kB raw`,
      );
    }
  };

  compare('initial', initial, budget.initial);

  const routePages = {
    editor: 'editor-page.tsx',
    production: 'production-page.tsx',
    review: 'review-page.tsx',
  };

  for (const [route, pageFile] of Object.entries(routePages)) {
    const found = findRoute(pageFile);
    if (!found) {
      failures.push(`${route}: no dynamic chunk found for ${pageFile} — route splitting regressed`);
      continue;
    }
    const [key, entry] = found;
    if (initialKeys.has(key)) {
      failures.push(`${route}: ${pageFile} is part of the initial bundle — not split`);
      continue;
    }
    const routeKeys = [...closure([key])].filter((imported) => !initialKeys.has(imported));
    const actual = await measure(routeKeys);
    const limit = budget.routes?.[route];
    if (!limit) continue;
    compare(route, actual, limit);
  }

  // Largest emitted chunk (deduplicated by file).
  const chunkSizes = new Map();
  for (const [, entry] of entries) {
    const file = entry.file;
    if (!file?.endsWith('.js') || chunkSizes.has(file)) continue;
    chunkSizes.set(file, await fileSize(file));
  }
  const [largestFile, largestSize] = [...chunkSizes.entries()].sort(
    (a, b) => b[1].gzip - a[1].gzip,
  )[0] ?? ['-', { raw: 0, gzip: 0 }];
  compare(`largest chunk (${path.basename(largestFile)})`, largestSize, budget.chunk);

  console.log(`\nBundle budget · ${path.relative(workspaceRoot, dist) || dist}`);
  console.log('─'.repeat(64));
  for (const { label, actual, limit, ok } of results) {
    const mark = ok ? '✓' : '✗';
    console.log(
      `${mark} ${label.padEnd(28)} ${String(toKb(actual.gzip)).padStart(7)} kB gzip ` +
        `${String(toKb(actual.raw)).padStart(8)} kB raw  ` +
        `(budget ${limit.gzipKb} / ${limit.rawKb})`,
    );
  }
  console.log('─'.repeat(64));

  if (failures.length > 0) {
    console.error('\nBundle budget exceeded:\n');
    for (const failure of failures) console.error(`  • ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('All bundle budgets satisfied.\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
