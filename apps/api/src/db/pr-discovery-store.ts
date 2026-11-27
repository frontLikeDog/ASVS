import type { DatabaseSync } from 'node:sqlite';
import {
  claimCandidateIdSchema,
  claimVerificationRecordV1Schema,
  prChangeCandidateV1Schema,
  type ClaimCandidateV1,
  type ClaimVerificationRecordV1,
  type PRChangeCandidateV1,
  type PRChangeClassification,
} from '@asvs/domain';

interface CandidateRow {
  payload: string;
}

interface VerificationRow {
  payload: string;
}

function decodeCandidate(row: CandidateRow): PRChangeCandidateV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error('pr_change_candidates.payload 不是有效 JSON');
  }
  // Read-side validation mirrors the snapshot store: a half-written payload
  // must fail loudly instead of feeding a broken claim into the publish gate.
  return prChangeCandidateV1Schema.parse(parsed);
}

function decodeVerification(row: VerificationRow): ClaimVerificationRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error('claim_verifications.payload 不是有效 JSON');
  }
  return claimVerificationRecordV1Schema.parse(parsed);
}

export interface ListPRCandidatesFilter {
  classification?: PRChangeClassification;
  pullNumber?: number;
  limit?: number;
}

/**
 * Step 4C persistence.
 *
 * `pr_change_candidates` holds one mutable analysis row per (repo, PR); the
 * deterministic candidate id makes re-analysis an update, and the service is
 * responsible for carrying previously recorded human/runtime evidence across.
 * `claim_verifications` is an append-only audit trail: no update or delete
 * path exists, matching docs/08 §6.
 */
export class SqlitePRDiscoveryStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(candidate: PRChangeCandidateV1): PRChangeCandidateV1 {
    const validated = prChangeCandidateV1Schema.parse(candidate);
    this.db
      .prepare(
        `INSERT INTO pr_change_candidates
          (id, repo, pull_number, classification, promotable, merged, merge_commit_sha,
           snapshot_id, analyzed_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           classification = excluded.classification,
           promotable = excluded.promotable,
           merged = excluded.merged,
           merge_commit_sha = excluded.merge_commit_sha,
           snapshot_id = excluded.snapshot_id,
           analyzed_at = excluded.analyzed_at,
           updated_at = excluded.updated_at,
           payload = excluded.payload`,
      )
      .run(
        validated.id,
        validated.repo,
        validated.pullNumber,
        validated.classification,
        validated.promotable ? 1 : 0,
        validated.merged ? 1 : 0,
        validated.mergeCommitSha,
        validated.snapshotId ?? null,
        validated.analyzedAt,
        validated.analyzedAt,
        JSON.stringify(validated),
      );
    return validated;
  }

  get(repo: string, candidateId: string): PRChangeCandidateV1 | null {
    const row = this.db
      .prepare('SELECT payload FROM pr_change_candidates WHERE repo = ? AND id = ?')
      .get(repo, candidateId) as CandidateRow | undefined;
    return row ? decodeCandidate(row) : null;
  }

  getByPullNumber(repo: string, pullNumber: number): PRChangeCandidateV1 | null {
    const row = this.db
      .prepare('SELECT payload FROM pr_change_candidates WHERE repo = ? AND pull_number = ?')
      .get(repo, pullNumber) as CandidateRow | undefined;
    return row ? decodeCandidate(row) : null;
  }

  list(repo: string, filter: ListPRCandidatesFilter = {}): PRChangeCandidateV1[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const clauses = ['repo = ?'];
    const params: Array<string | number> = [repo];
    if (filter.classification) {
      clauses.push('classification = ?');
      params.push(filter.classification);
    }
    if (filter.pullNumber !== undefined) {
      clauses.push('pull_number = ?');
      params.push(filter.pullNumber);
    }
    const rows = this.db
      .prepare(
        `SELECT payload FROM pr_change_candidates
          WHERE ${clauses.join(' AND ')}
          ORDER BY analyzed_at DESC, pull_number DESC
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as CandidateRow[];
    return rows.map(decodeCandidate);
  }

  findClaim(
    repo: string,
    claimId: string,
  ): { candidate: PRChangeCandidateV1; claim: ClaimCandidateV1 } | null {
    // Claims are few (one per candidate today) and stored inside the payload;
    // scanning the repo's candidates keeps the schema simple and avoids a
    // second source of truth that could drift from the candidate payload.
    // The id shape is validated first so it can never act as a LIKE wildcard.
    if (!claimCandidateIdSchema.safeParse(claimId).success) return null;
    const rows = this.db
      .prepare(
        `SELECT payload FROM pr_change_candidates
          WHERE repo = ? AND payload LIKE ?
          ORDER BY analyzed_at DESC`,
      )
      .all(repo, `%${claimId}%`) as unknown as CandidateRow[];
    for (const row of rows) {
      const candidate = decodeCandidate(row);
      const claim = candidate.claims.find((item) => item.id === claimId);
      if (claim) return { candidate, claim };
    }
    return null;
  }

  appendVerification(record: ClaimVerificationRecordV1): ClaimVerificationRecordV1 {
    const validated = claimVerificationRecordV1Schema.parse(record);
    const { evidence, input } = validated;
    this.db
      .prepare(
        `INSERT INTO claim_verifications
          (id, repo, candidate_id, claim_id, kind, decision, environment_id, release_tag,
           test_run_id, commit_sha, file_path, source_digest, note, recorded_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.repo,
        validated.candidateId,
        validated.claimId,
        evidence.kind,
        evidence.decision ?? null,
        evidence.environmentId ?? null,
        evidence.releaseTag ?? null,
        evidence.testRunId ?? null,
        evidence.commitSha ?? null,
        evidence.filePath ?? null,
        evidence.sourceDigest ?? null,
        input.note,
        validated.recordedAt,
        JSON.stringify(validated),
      );
    return validated;
  }

  listVerifications(repo: string, claimId: string): ClaimVerificationRecordV1[] {
    const rows = this.db
      .prepare(
        `SELECT payload FROM claim_verifications
          WHERE repo = ? AND claim_id = ?
          ORDER BY recorded_at ASC, rowid ASC`,
      )
      .all(repo, claimId) as unknown as VerificationRow[];
    return rows.map(decodeVerification);
  }
}
