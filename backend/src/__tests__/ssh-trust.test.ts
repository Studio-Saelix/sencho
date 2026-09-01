import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSshCommand,
  canonicalizeDeployKeyPem,
  canonicalizeKnownHostsEntry,
  fingerprintFromKnownHostsLine,
  parseRepoTransportUrl,
  parseSshScpUrl,
  parseSshUrl,
} from '../services/git/sshTrust';
import { classifyGitFailure } from '../services/git/errors';

describe('sshTrust URL parsing', () => {
  it('parses scp-style URLs', () => {
    const parsed = parseSshScpUrl('git@github.com:org/repo.git');
    expect(parsed?.host).toBe('github.com');
    expect(parsed?.port).toBe(22);
    expect(parsed?.href).toBe('git@github.com:org/repo.git');
  });

  it('parses scp-style URLs with nonstandard port via ssh://', () => {
    const parsed = parseSshUrl('ssh://git@git.example.com:2222/org/repo.git');
    expect(parsed?.port).toBe(2222);
    expect(parsed?.href).toBe('ssh://git@git.example.com:2222/org/repo.git');
  });

  it('parses ssh:// URLs', () => {
    const parsed = parseSshUrl('ssh://git@host.example:2222/org/repo.git');
    expect(parsed?.host).toBe('host.example');
    expect(parsed?.port).toBe(2222);
  });

  it('preserves absolute paths in default-port ssh:// URLs', () => {
    const parsed = parseSshUrl('ssh://git@host.example/abs/path/repo.git');
    expect(parsed?.href).toBe('git@host.example:/abs/path/repo.git');
    expect(parsed?.pathname).toBe('/abs/path/repo.git');
  });

  it('classifies transport kind from mixed inputs', () => {
    expect(parseRepoTransportUrl('https://github.com/org/repo.git')?.kind).toBe('https');
    expect(parseRepoTransportUrl('git@host:org/repo.git')?.kind).toBe('ssh');
  });
});

describe('ssh host key fingerprint', () => {
  it('computes SHA256 fingerprint from the key material, not the key type', () => {
    const keyBase64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
    const line = `|1|abc|abc ssh-ed25519 ${keyBase64}`;
    const fp = fingerprintFromKnownHostsLine(line);
    const expected = `SHA256:${createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '')}`;
    expect(fp).toBe(expected);
  });
});

describe('ssh credential canonicalization', () => {
  it('rebuilds known_hosts lines from parsed key material only', () => {
    const keyBase64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3JzL3Rlc3Q=';
    const raw = `git.example.com ssh-ed25519 ${keyBase64} trailing-garbage`;
    const canonical = canonicalizeKnownHostsEntry(raw);
    expect(canonical).toBe(`git.example.com ssh-ed25519 ${keyBase64}\n`);
    expect(canonical).not.toContain('trailing-garbage');
  });

  it('rejects invalid known_hosts lines', () => {
    expect(() => canonicalizeKnownHostsEntry('not-a-host-key')).toThrow(/invalid|empty/i);
  });

  it('rebuilds deploy key PEM from validated envelope and body', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJj\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(canonicalizeDeployKeyPem(pem)).toBe(pem);
  });

  it('rejects malformed deploy keys', () => {
    expect(() => canonicalizeDeployKeyPem('not a pem')).toThrow(/invalid/i);
  });
});

describe('ssh command builder', () => {
  it('enforces strict host key checking', () => {
    const cmd = buildSshCommand('/tmp/key', '/tmp/known_hosts', {
      address: '10.0.0.8',
      hostKeyAlias: 'git.internal.example',
    });
    expect(cmd).toContain('StrictHostKeyChecking=yes');
    expect(cmd).toContain('UserKnownHostsFile=/tmp/known_hosts');
    expect(cmd).toContain('IdentitiesOnly=yes');
  });

  it('pins the address while retaining the repository host identity', () => {
    const cmd = buildSshCommand('/tmp/key', '/tmp/known_hosts', {
      address: '10.0.0.8',
      hostKeyAlias: '[git.internal.example]:2222',
    });
    expect(cmd).toContain('Hostname=10.0.0.8');
    expect(cmd).toContain('HostKeyAlias=[git.internal.example]:2222');
  });
});

describe('SSH stderr classification', () => {
  it('maps host key verification failure to SSH_HOST_KEY_FAILED', () => {
    const result = classifyGitFailure({
      transportFailure: true,
      reason: 'exit',
      host: 'git.example.com',
      hasToken: true,
      stderr: 'Host key verification failed.',
    });
    expect(result.code).toBe('SSH_HOST_KEY_FAILED');
  });

  it('maps publickey denial with credential to AUTH_FAILED', () => {
    const result = classifyGitFailure({
      transportFailure: true,
      reason: 'exit',
      host: 'git.example.com',
      hasToken: true,
      stderr: 'git@git.example.com: Permission denied (publickey).',
    });
    expect(result.code).toBe('AUTH_FAILED');
  });
});
