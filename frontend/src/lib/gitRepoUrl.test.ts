import { describe, expect, it } from 'vitest';
import { isSupportedGitRepoUrl } from './gitRepoUrl';

describe('isSupportedGitRepoUrl', () => {
  it('accepts HTTPS URLs', () => {
    expect(isSupportedGitRepoUrl('https://github.com/org/repo.git')).toBe(true);
  });

  it('accepts scp-style SSH URLs with any username', () => {
    expect(isSupportedGitRepoUrl('git@github.com:org/repo.git')).toBe(true);
    expect(isSupportedGitRepoUrl('gituser@git.example.com:org/repo.git')).toBe(true);
  });

  it('accepts ssh:// URLs with any username', () => {
    expect(isSupportedGitRepoUrl('ssh://gituser@git.example.com:2222/org/repo.git')).toBe(true);
  });

  it('rejects malformed or unsupported URLs', () => {
    expect(isSupportedGitRepoUrl('git@host-only')).toBe(false);
    expect(isSupportedGitRepoUrl('http://github.com/org/repo.git')).toBe(false);
    expect(isSupportedGitRepoUrl('@host:repo.git')).toBe(false);
    expect(isSupportedGitRepoUrl('git@host:../escape.git')).toBe(false);
  });
});
