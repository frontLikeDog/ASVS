import path from 'node:path';
import { defaultPlan } from './paths';
import { parseDemoPlanFile } from './plan';

/**
 * Prints the digest a DemoPlan must record in `approval.approvedPlanDigest`.
 * This intentionally does not require the current digest to match: it exists
 * so a human can review a changed plan and then re-approve it.
 */
function main(): void {
  const file = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultPlan;
  const parsed = parseDemoPlanFile(file);
  console.log(parsed.digest);
  console.error(`plan: ${parsed.relativeFile}`);
  console.error(`steps: ${parsed.plan.steps.length}`);
}

main();
