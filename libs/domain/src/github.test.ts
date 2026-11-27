import { describe, expect, it } from 'vitest';
import {
  auditGitHubPermissions,
  formatGitHubRepoRef,
  parseGitHubRepoRef,
} from './github';

describe('github domain contracts', () => {
  it('parses owner/repo and https://github.com URLs', () => {
    expect(parseGitHubRepoRef('frontLikeDog/livenotes')).toEqual({
      owner: 'frontLikeDog',
      repo: 'livenotes',
    });
    expect(parseGitHubRepoRef('https://github.com/frontLikeDog/livenotes')).toEqual({
      owner: 'frontLikeDog',
      repo: 'livenotes',
    });
    expect(parseGitHubRepoRef('https://github.com/frontLikeDog/livenotes.git/')).toEqual({
      owner: 'frontLikeDog',
      repo: 'livenotes',
    });
    expect(formatGitHubRepoRef({ owner: 'frontLikeDog', repo: 'livenotes' })).toBe(
      'frontLikeDog/livenotes',
    );
  });

  it('rejects non-GitHub hosts, credentials, query strings, and path traversal', () => {
    const invalid = [
      '',
      'only-owner',
      'a/b/c',
      '../secret',
      'owner/..',
      'http://github.com/frontLikeDog/livenotes',
      'https://evil.example/frontLikeDog/livenotes',
      'https://user:pass@github.com/frontLikeDog/livenotes',
      'https://github.com/frontLikeDog/livenotes?foo=bar',
      'https://github.com/frontLikeDog/livenotes/pulls',
    ];
    for (const candidate of invalid) {
      expect(() => parseGitHubRepoRef(candidate)).toThrow();
    }
  });

  it('audits read-only vs write/admin permissions', () => {
    expect(
      auditGitHubPermissions({
        contents: 'read',
        pull_requests: 'read',
        metadata: 'read',
        issues: 'none',
      }),
    ).toEqual({
      readOnly: true,
      permissions: {
        contents: 'read',
        pull_requests: 'read',
        metadata: 'read',
        issues: 'none',
      },
      writePermissions: [],
    });

    expect(
      auditGitHubPermissions({
        contents: 'write',
        pull_requests: 'read',
        administration: 'admin',
      }),
    ).toEqual({
      readOnly: false,
      permissions: {
        contents: 'write',
        pull_requests: 'read',
        administration: 'admin',
      },
      writePermissions: ['administration:admin', 'contents:write'],
    });
  });
});
