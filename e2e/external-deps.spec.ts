/**
 * Unit coverage for the shared dependency probes in externalDeps.ts.
 *
 * Not a browser test: these run against the probe functions directly with an
 * injected predicate, so absence of git/sshd/Docker can be exercised without
 * removing system binaries.
 */
import { test, expect } from '@playwright/test';
import { requireDockerCli, requireGitBinary, requireSshd } from './externalDeps';

test.describe('external dependency probes', () => {
  test.afterEach(() => {
    delete process.env.CI;
  });

  test('requireGitBinary returns true when git is present, locally or in CI', () => {
    delete process.env.CI;
    expect(requireGitBinary(() => true)).toBe(true);
    process.env.CI = '1';
    expect(requireGitBinary(() => true)).toBe(true);
  });

  test('requireGitBinary returns false when git is absent locally', () => {
    delete process.env.CI;
    expect(requireGitBinary(() => false)).toBe(false);
  });

  test('requireGitBinary throws when git is absent under CI', () => {
    process.env.CI = '1';
    expect(() => requireGitBinary(() => false)).toThrow(/git is required in CI/);
  });

  test('requireSshd returns true when sshd is present, locally or in CI', () => {
    delete process.env.CI;
    expect(requireSshd(() => true)).toBe(true);
    process.env.CI = '1';
    expect(requireSshd(() => true)).toBe(true);
  });

  test('requireSshd returns false when sshd is absent locally', () => {
    delete process.env.CI;
    expect(requireSshd(() => false)).toBe(false);
  });

  test('requireSshd throws when sshd is absent under CI', () => {
    process.env.CI = '1';
    expect(() => requireSshd(() => false)).toThrow(/sshd is required in CI/);
  });

  test('requireDockerCli returns true when Docker is present, locally or in CI', () => {
    delete process.env.CI;
    expect(requireDockerCli(() => true)).toBe(true);
    process.env.CI = '1';
    expect(requireDockerCli(() => true)).toBe(true);
  });

  test('requireDockerCli returns false when Docker is absent locally', () => {
    delete process.env.CI;
    expect(requireDockerCli(() => false)).toBe(false);
  });

  test('requireDockerCli throws when Docker is absent under CI', () => {
    process.env.CI = '1';
    expect(() => requireDockerCli(() => false)).toThrow(/Docker CLI with the Compose plugin is required in CI/);
  });

  test('requireDockerCli fails on an installed but unusable Docker, locally and in CI', () => {
    const unusable: () => boolean = () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    delete process.env.CI;
    expect(() => requireDockerCli(unusable)).toThrow(/Cannot connect to the Docker daemon/);
    process.env.CI = '1';
    expect(() => requireDockerCli(unusable)).toThrow(/Cannot connect to the Docker daemon/);
  });
});
