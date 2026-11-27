const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9_]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export function redactSecrets(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export type GitHubErrorCode =
  | 'github_not_configured'
  | 'invalid_github_request'
  | 'github_write_permission_detected'
  | 'github_auth_error'
  | 'github_forbidden'
  | 'github_not_found'
  | 'github_rate_limited'
  | 'github_upstream_error';

export class GitHubApiError extends Error {
  readonly code: GitHubErrorCode;
  readonly httpStatus: number;
  readonly upstreamStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: GitHubErrorCode;
    httpStatus: number;
    message: string;
    upstreamStatus?: number;
    details?: Record<string, unknown>;
  }) {
    super(redactSecrets(options.message));
    this.name = 'GitHubApiError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.upstreamStatus = options.upstreamStatus;
    this.details = options.details;
  }
}
