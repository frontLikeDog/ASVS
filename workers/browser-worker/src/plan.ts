import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  demoPlanV1Schema,
  stableStringify,
  type DemoPlanV1,
} from '@asvs/domain';
import { storageRefFor } from './paths';

export class DemoPlanError extends Error {
  override name = 'DemoPlanError';
}

interface IssueLike {
  path: (string | number)[];
  message: string;
}

function formatIssues(issues: IssueLike[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${where}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * The approval binds the plan content, not the approval block itself. Changing
 * any step, origin, viewport or fixture after approval invalidates the digest
 * (docs/08 §9 case 7).
 */
export function demoPlanDigest(plan: DemoPlanV1): string {
  const { approval: _approval, ...rest } = plan;
  return createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex');
}

export interface ParsedDemoPlan {
  plan: DemoPlanV1;
  digest: string;
  file: string;
  relativeFile: string;
}

/** Parses and validates the plan without checking the approval digest. */
export function parseDemoPlanFile(file: string): ParsedDemoPlan {
  let raw: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    raw = file.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new DemoPlanError(
      `无法读取 DemoPlan ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = demoPlanV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new DemoPlanError(`DemoPlan 校验失败（${path.basename(file)}）：\n${formatIssues(parsed.error.issues)}`);
  }

  const plan = parsed.data;
  return {
    plan,
    digest: demoPlanDigest(plan),
    file,
    relativeFile: storageRefFor(file),
  };
}

/**
 * Loads a plan that must already carry a matching approval. There is no
 * `--skip-approval`: an unapproved plan never reaches a browser.
 */
export function loadApprovedDemoPlan(file: string): ParsedDemoPlan {
  const parsed = parseDemoPlanFile(file);
  const recorded = parsed.plan.approval.approvedPlanDigest;
  if (recorded !== parsed.digest) {
    throw new DemoPlanError(
      [
        `DemoPlan 审批摘要不匹配：${parsed.relativeFile}`,
        `  已批准：${recorded}`,
        `  当前值：${parsed.digest}`,
        '计划内容在批准后被修改，旧审批已失效（docs/08 §9 用例 7）。',
        '请重新审阅，并用 `pnpm nx run browser-worker:plan-digest` 写回新摘要。',
      ].join('\n'),
    );
  }
  return parsed;
}
