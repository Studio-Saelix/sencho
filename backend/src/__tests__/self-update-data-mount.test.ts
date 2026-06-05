/**
 * findDataDirHost detects the host-side path for /app/data across bind AND
 * named-volume mounts. Pre-fix the helper bound the resolver to Type='bind'
 * only, so a pilot-agent deployed with the recommended `sencho-agent-data:/
 * app/data` named volume logged "/app/data mount not found - update error
 * recovery will be unavailable" at boot.
 */
import { describe, expect, it } from 'vitest';
import { buildSelfUpdateComposeCmd, findDataDirHost } from '../services/SelfUpdateService';

describe('findDataDirHost', () => {
  it('returns the host path for a bind mount at /app/data', () => {
    const source = findDataDirHost([
      { Type: 'bind', Source: '/opt/sencho/data', Destination: '/app/data' },
    ]);
    expect(source).toBe('/opt/sencho/data');
  });

  it('returns the host path for a named volume at /app/data', () => {
    const source = findDataDirHost([
      { Type: 'volume', Source: '/var/lib/docker/volumes/sencho-agent-data/_data', Destination: '/app/data' },
    ]);
    expect(source).toBe('/var/lib/docker/volumes/sencho-agent-data/_data');
  });

  it('returns null when no mount targets /app/data', () => {
    const source = findDataDirHost([
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
      { Type: 'bind', Source: '/opt/compose', Destination: '/app/compose' },
    ]);
    expect(source).toBeNull();
  });

  it('picks the /app/data mount out of a mixed list and ignores siblings', () => {
    const source = findDataDirHost([
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
      { Type: 'volume', Source: '/var/lib/docker/volumes/sencho-agent-data/_data', Destination: '/app/data' },
      { Type: 'bind', Source: '/opt/compose', Destination: '/app/compose' },
    ]);
    expect(source).toBe('/var/lib/docker/volumes/sencho-agent-data/_data');
  });

  it('returns null when a /app/data entry carries no Source', () => {
    const source = findDataDirHost([
      { Type: 'bind', Source: '', Destination: '/app/data' },
    ]);
    expect(source).toBeNull();
  });

  it('ignores tmpfs and other non-bind/volume types', () => {
    const source = findDataDirHost([
      { Type: 'tmpfs', Source: '', Destination: '/app/data' },
    ]);
    expect(source).toBeNull();
  });
});

describe('buildSelfUpdateComposeCmd', () => {
  const fFlags = ['-f', '/app/docker-compose.yml'];
  const stderrTmp = '/tmp/_sencho_err';
  const errorFile = '/app/data/.sencho-update-error';

  it('appends a success-guarded dangling-image prune when pruneOnUpdate is true', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, true);
    expect(cmd).toContain('if [ $ec -eq 0 ]; then docker image prune -f');
    // Prune must never change the helper exit code, so the command still ends on exit $ec.
    expect(cmd.trim().endsWith('exit $ec')).toBe(true);
    // Order matters: the prune must run after $ec is captured and after the
    // error-file write, or it could shadow the recreate's exit code / clobber
    // the error file. Lock the ordering, not just the presence of the line.
    expect(cmd.indexOf('ec=$?')).toBeLessThan(cmd.indexOf('docker image prune'));
    expect(cmd.indexOf(errorFile)).toBeLessThan(cmd.indexOf('docker image prune'));
  });

  it('omits the prune entirely when pruneOnUpdate is false', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, false);
    expect(cmd).not.toContain('docker image prune');
  });

  it('always recreates the service and persists the error file on failure', () => {
    const cmd = buildSelfUpdateComposeCmd(fFlags, 'sencho', stderrTmp, errorFile, true);
    expect(cmd).toContain('up -d --force-recreate sencho');
    expect(cmd).toContain(`> ${errorFile}`);
  });
});
