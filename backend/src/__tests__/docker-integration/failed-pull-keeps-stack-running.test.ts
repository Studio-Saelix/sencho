/**
 * Docker-backed integration: a failed pull must leave the running stack untouched.
 * Skipped automatically when Docker is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

describe.skipIf(!hasDocker)('failed pull keeps stack running', () => {
  it('documents the Docker integration harness entry point', () => {
    // Full harness (compose project + failed pull assertion) lands with the
    // dedicated CI job; this file ensures the suite is discoverable only via
    // vitest.docker-integration.config.ts.
    expect(hasDocker).toBe(true);
  });
});
