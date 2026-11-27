// @vitest-environment node
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubAppReadOnlyClient } from './github-app-client';
import { createGitHubAppJwt } from './jwt';
import { GitHubApiError, redactSecrets } from './redact';

const TEST_KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const REPO = { owner: 'frontLikeDog', repo: 'livenotes' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub App JWT & 脱敏', () => {
  it('使用 RS256 签发可验证的短生命周期 JWT', () => {
    const nowMs = Date.parse('2026-11-27T12:00:00.000Z');
    const jwt = createGitHubAppJwt({
      appId: '5947613',
      privateKeyPem: TEST_KEYS.privateKey,
      nowMs,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('5947613');
    expect(payload.exp - payload.iat).toBe(600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify(TEST_KEYS.publicKey, Buffer.from(encodedSig, 'base64url'))).toBe(true);
  });

  it('从错误信息中彻底脱敏 Token、JWT 与 PEM 私钥', () => {
    const leaky = [
      'Authorization: Bearer ghs_secretToken1234567890',
      'token=github_pat_1234567890abcdef',
      'jwt=eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlMTIz',
      TEST_KEYS.privateKey,
    ].join('\n');

    const cleaned = redactSecrets(leaky);
    expect(cleaned).not.toContain('ghs_secretToken1234567890');
    expect(cleaned).not.toContain('github_pat_1234567890abcdef');
    expect(cleaned).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(cleaned).not.toContain('PRIVATE KEY');
  });
});

describe('GitHubAppReadOnlyClient · 只读策略与安全边界', () => {
  it('只读安装可列出 PR、文件、Release 与 README，且复用缓存令牌', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let tokenExchanges = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (url.endsWith('/app/installations/186376455/access_tokens') && method === 'POST') {
        tokenExchanges += 1;
        return jsonResponse(
          {
            token: 'ghs_readonlyTokenExample123456',
            expires_at: '2026-11-27T13:00:00.000Z',
            repository_selection: 'selected',
            permissions: {
              contents: 'read',
              pull_requests: 'read',
              metadata: 'read',
            },
          },
          201,
        );
      }

      if (url.includes('/installation/repositories')) {
        return jsonResponse({
          repositories: [{ full_name: 'frontLikeDog/livenotes' }],
        });
      }

      if (url.endsWith('/repos/frontLikeDog/livenotes') && method === 'GET') {
        return jsonResponse({
          id: 101,
          owner: { login: 'frontLikeDog' },
          name: 'livenotes',
          full_name: 'frontLikeDog/livenotes',
          description: 'LiveNotes app',
          private: true,
          default_branch: 'main',
          html_url: 'https://github.com/frontLikeDog/livenotes',
          pushed_at: '2026-11-26T10:00:00Z',
          updated_at: '2026-11-26T10:00:00Z',
        });
      }

      if (url.includes('/repos/frontLikeDog/livenotes/pulls?')) {
        return jsonResponse([
          {
            id: 201,
            number: 12,
            title: 'feat: add live markdown sync',
            body: 'Syncs notes across tabs',
            state: 'closed',
            draft: false,
            merged_at: '2026-11-26T09:00:00Z',
            created_at: '2026-11-25T09:00:00Z',
            updated_at: '2026-11-26T09:00:00Z',
            user: { login: 'frontLikeDog' },
            labels: [{ name: 'feature' }],
            head: { sha: 'abc1234567890', ref: 'feat/sync' },
            base: { ref: 'main' },
            merge_commit_sha: 'def4567890123',
            html_url: 'https://github.com/frontLikeDog/livenotes/pull/12',
          },
        ]);
      }

      if (url.includes('/repos/frontLikeDog/livenotes/pulls/12/files')) {
        return jsonResponse([
          {
            filename: 'src/sync.ts',
            status: 'added',
            additions: 80,
            deletions: 0,
            changes: 80,
            patch: '@@ -0,0 +1,2 @@\n+export const sync = true;',
          },
        ]);
      }

      if (url.includes('/repos/frontLikeDog/livenotes/releases')) {
        return jsonResponse([
          {
            id: 301,
            tag_name: 'v0.1.0',
            name: 'First Release',
            body: 'Initial notes release',
            draft: false,
            prerelease: false,
            created_at: '2026-11-26T08:00:00Z',
            published_at: '2026-11-26T08:30:00Z',
            target_commitish: 'main',
            html_url: 'https://github.com/frontLikeDog/livenotes/releases/tag/v0.1.0',
          },
        ]);
      }

      if (url.includes('/repos/frontLikeDog/livenotes/contents/README.md')) {
        return jsonResponse({
          type: 'file',
          path: 'README.md',
          sha: 'feedbeef123',
          size: 11,
          encoding: 'base64',
          content: Buffer.from('# LiveNotes').toString('base64'),
        });
      }

      return jsonResponse({ message: 'Not Found' }, 404);
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      defaultRepo: REPO,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    // Credentials must never leak when serialized
    expect(JSON.stringify(client)).toBe('{}');

    const status = await client.checkConnection();
    expect(status).toMatchObject({
      configured: true,
      connected: true,
      readOnly: true,
      repo: 'frontLikeDog/livenotes',
      repositorySelection: 'selected',
      accessibleRepositories: ['frontLikeDog/livenotes'],
      writePermissions: [],
    });

    const pulls = await client.listPullRequests(REPO, { state: 'all', limit: 10 });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      number: 12,
      merged: true,
      author: 'frontLikeDog',
      labels: ['feature'],
    });

    const filesWithoutPatch = await client.listPullRequestFiles(REPO, 12);
    expect(filesWithoutPatch[0]?.patch).toBeUndefined();

    const filesWithPatch = await client.listPullRequestFiles(REPO, 12, { includePatch: true });
    expect(filesWithPatch[0]?.patch).toContain('export const sync = true;');

    const releases = await client.listReleases(REPO);
    expect(releases[0]?.tagName).toBe('v0.1.0');

    const readme = await client.getFileContent(REPO, 'README.md');
    expect(readme?.content).toBe('# LiveNotes');
    expect(readme?.contentBase64).toBe(Buffer.from('# LiveNotes').toString('base64'));

    const missing = await client.getFileContent(REPO, 'DOES_NOT_EXIST.md');
    expect(missing).toBeNull();

    // Only 1 token exchange happened across all reads after checkConnection!
    expect(tokenExchanges).toBe(1);
    // All data calls must be strictly GET
    const dataCalls = calls.filter((c) => !c.url.endsWith('/access_tokens'));
    expect(dataCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('AC-01：当安装授予任何写权限时，默认拒绝读取且不发送写入探针', async () => {
    const methodsCalled: string[] = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      methodsCalled.push(`${init?.method ?? 'GET'} ${url}`);

      if (url.endsWith('/access_tokens')) {
        return jsonResponse(
          {
            token: 'ghs_overprivilegedToken123456',
            expires_at: '2026-11-27T13:00:00.000Z',
            permissions: {
              contents: 'write',
              pull_requests: 'read',
              metadata: 'read',
            },
          },
          201,
        );
      }

      throw new Error(`Unexpected upstream call: ${url}`);
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    const status = await client.checkConnection(REPO);
    expect(status.connected).toBe(false);
    expect(status.readOnly).toBe(false);
    expect(status.writePermissions).toEqual(['contents:write']);

    await expect(client.listPullRequests(REPO)).rejects.toMatchObject({
      code: 'github_write_permission_detected',
      httpStatus: 403,
    });

    const probe = await client.probeWriteBlocked(REPO);
    expect(probe.readOnlyToken).toBe(false);
    expect(probe.writeBlocked).toBe(false);
    expect(probe.statusCode).toBe(0);
    // Prove zero PATCH calls were sent when write permission was detected!
    expect(methodsCalled.every((entry) => entry.startsWith('POST '))).toBe(true);
  });

  it('AC-01：只读安装下，写入探针收到 GitHub 403 判定为 writeBlocked=true', async () => {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse(
          {
            token: 'ghs_readonlyToken1234567890',
            expires_at: '2026-11-27T13:00:00.000Z',
            permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' },
          },
          201,
        );
      }
      if (init?.method === 'PATCH' && url.endsWith('/repos/frontLikeDog/livenotes')) {
        return jsonResponse({ message: 'Resource not accessible by integration' }, 403);
      }
      return jsonResponse({ message: 'unexpected' }, 500);
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    const probe = await client.probeWriteBlocked(REPO);
    expect(probe).toMatchObject({
      repo: 'frontLikeDog/livenotes',
      readOnlyToken: true,
      writeBlocked: true,
      statusCode: 403,
      writePermissions: [],
    });
  });

  it('解析提交与递归文件树，并拒绝 truncated 的树', async () => {
    const seen: string[] = [];
    let truncated = false;

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse(
          {
            token: 'ghs_readonlyTokenExample123456',
            expires_at: '2026-11-27T13:00:00.000Z',
            permissions: { contents: 'read', metadata: 'read' },
          },
          201,
        );
      }
      if (url.includes('/commits/')) {
        return jsonResponse({
          sha: 'a'.repeat(40),
          commit: {
            tree: { sha: 'b'.repeat(40) },
            committer: { date: '2026-11-26T10:00:00Z' },
            message: 'feat: markdown preview\n\nbody',
          },
        });
      }
      if (url.includes('/git/trees/')) {
        return jsonResponse({
          sha: 'b'.repeat(40),
          truncated,
          tree: [
            { path: 'README.md', type: 'blob', sha: 'c'.repeat(40), size: 11 },
            { path: 'app', type: 'tree', sha: 'd'.repeat(40) },
            { path: 'app/main.py', type: 'blob', sha: 'e'.repeat(40), size: 42 },
            { path: 'submodule', type: 'commit', sha: 'f'.repeat(40) },
          ],
        });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      defaultRepo: REPO,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    const commit = await client.getCommit(REPO, 'main');
    expect(commit).toEqual({
      sha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      commitAt: '2026-11-26T10:00:00Z',
      message: 'feat: markdown preview',
    });

    const tree = await client.getRepositoryTree(REPO, commit.sha);
    expect(tree).toEqual([
      { path: 'README.md', type: 'blob', sha: 'c'.repeat(40), size: 11 },
      { path: 'app', type: 'tree', sha: 'd'.repeat(40), size: 0 },
      { path: 'app/main.py', type: 'blob', sha: 'e'.repeat(40), size: 42 },
      { path: 'submodule', type: 'commit', sha: 'f'.repeat(40), size: 0 },
    ]);
    expect(seen.find((url) => url.includes('/git/trees/'))).toContain('recursive=1');
    expect(seen.find((url) => url.includes('/commits/'))).toContain('/commits/main');

    truncated = true;
    await expect(client.getRepositoryTree(REPO, commit.sha)).rejects.toMatchObject({
      code: 'github_upstream_error',
      httpStatus: 502,
    });
  });

  it('分支名中的斜杠被保留，穿越与查询注入被拒绝', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse(
          {
            token: 'ghs_readonlyTokenExample123456',
            expires_at: '2026-11-27T13:00:00.000Z',
            permissions: { contents: 'read' },
          },
          201,
        );
      }
      return jsonResponse({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    await client.getCommit(REPO, 'feat/live-notes');
    expect(calls.some((url) => url.endsWith('/commits/feat/live-notes'))).toBe(true);

    for (const badRef of ['../main', 'main?x=1', 'a//b', '/main', 'main\\x']) {
      await expect(client.getCommit(REPO, badRef)).rejects.toMatchObject({
        code: 'invalid_github_request',
        httpStatus: 400,
      });
    }
  });

  it('撤销授权或路径穿越返回明确错误且不泄露凭证', async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({ message: 'Bad credentials for ghs_shouldNeverLeak123456' }, 401);

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      fetchImpl: fakeFetch,
    });

    await expect(client.getFileContent(REPO, '../.env')).rejects.toMatchObject({
      code: 'invalid_github_request',
      httpStatus: 400,
    });

    try {
      await client.getRepository(REPO);
      expect.fail('Expected auth error');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      const apiErr = error as GitHubApiError;
      expect(apiErr.code).toBe('github_auth_error');
      expect(apiErr.message).not.toContain('ghs_shouldNeverLeak123456');
    }
  });

  it('保留非 UTF-8 文件的原始 base64 字节供二进制检测使用', async () => {
    const rawBinary = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x41, 0x42]);
    const expectedBase64 = rawBinary.toString('base64');

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse(
          {
            token: 'ghs_readonlyTokenExample123456',
            expires_at: '2026-11-27T13:00:00.000Z',
            permissions: { contents: 'read', metadata: 'read' },
          },
          201,
        );
      }
      if (url.includes('/repos/frontLikeDog/livenotes/contents/raw.bin')) {
        return jsonResponse({
          type: 'file',
          path: 'raw.bin',
          sha: 'a'.repeat(40),
          size: rawBinary.byteLength,
          encoding: 'base64',
          content: `${expectedBase64.slice(0, 4)}\n${expectedBase64.slice(4)}\n`,
        });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    };

    const client = new GitHubAppReadOnlyClient({
      appId: '5947613',
      installationId: '186376455',
      privateKeyPem: TEST_KEYS.privateKey,
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-11-27T12:10:00.000Z'),
    });

    const file = await client.getFileContent(REPO, 'raw.bin');
    expect(file?.contentBase64).toBe(expectedBase64);
  });
});
