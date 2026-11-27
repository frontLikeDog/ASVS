import { createSign } from 'node:crypto';
import { GitHubApiError } from './redact';

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface CreateGitHubAppJwtOptions {
  appId: string;
  privateKeyPem: string;
  nowMs?: number;
}

/**
 * Signs a short-lived RS256 JWT for authenticating as a GitHub App.
 * Uses Node's built-in `node:crypto` so zero third-party JWT deps are needed.
 */
export function createGitHubAppJwt(options: CreateGitHubAppJwtOptions): string {
  const appId = options.appId.trim();
  if (!/^\d+$/.test(appId)) {
    throw new GitHubApiError({
      code: 'invalid_github_request',
      httpStatus: 500,
      message: 'GITHUB_APP_ID 必须为纯数字。',
    });
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // GitHub allows up to 10 minutes; 60s clock-drift backdate + 9m expiry is standard.
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSec - 60,
      exp: nowSec + 540,
      iss: appId,
    }),
  );

  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(options.privateKeyPem);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  } catch {
    throw new GitHubApiError({
      code: 'github_auth_error',
      httpStatus: 500,
      message: 'GitHub App 私钥无法用于 RS256 签名，请检查 PEM 私钥文件是否完整有效。',
    });
  }
}
