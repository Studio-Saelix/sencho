/**
 * findDataDirHost detects the host-side path for /app/data across bind AND
 * named-volume mounts. Pre-fix the helper bound the resolver to Type='bind'
 * only, so a pilot-agent deployed with the recommended `sencho-agent-data:/
 * app/data` named volume logged "/app/data mount not found - update error
 * recovery will be unavailable" at boot.
 */
import { describe, expect, it } from 'vitest';
import { buildSelfUpdateComposeCmd, buildSelfUpdateRunArgs, findDataDirHost, shQuote } from '../services/SelfUpdateService';

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
    // The prune suppresses its own output and `|| true` so it can never alter
    // the helper exit code; the command still ends on exit $ec.
    expect(cmd).toContain('docker image prune -f >/dev/null 2>&1 || true');
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
    expect(cmd).toContain(`up -d --force-recreate ${shQuote('sencho')}`);
    expect(cmd).toContain(`> ${errorFile}`);
  });

  it('shell-quotes label-derived values so metacharacters cannot break the command', () => {
    // serviceName and config paths come from Docker Compose labels; a hostile
    // label must stay inert data, not run as a second command.
    const evilFlags = ['-f', '/tmp/compose.yml; ec=0; #'];
    const cmd = buildSelfUpdateComposeCmd(evilFlags, 'svc; rm -rf /', stderrTmp, errorFile, true);
    // The dangerous text survives only inside single quotes, never as bare shell.
    expect(cmd).toContain(shQuote('/tmp/compose.yml; ec=0; #'));
    expect(cmd).toContain(shQuote('svc; rm -rf /'));
    expect(cmd).not.toContain('up -d --force-recreate svc; rm -rf /');
    // The recreate line stays intact: its redirection and the real exit-code
    // capture follow the quoted args, so the injected `ec=0` never runs as shell.
    expect(cmd).toContain(`2>${stderrTmp}; ec=$?;`);
  });
});

describe('buildSelfUpdateRunArgs', () => {
  // Sentinel for the compose command so we can assert it stays a single,
  // isolated argv element rather than being fused with any operator path.
  const COMPOSE = 'COMPOSE_CMD';

  it('emits the exact docker run argv (locks flag/mount/-w/image/-c ordering)', () => {
    // `docker run [OPTIONS] IMAGE [COMMAND]`: a misplaced flag after the image
    // becomes a container arg and the recreate fails silently, so lock the
    // whole array, not just containment.
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/opt/sencho',
        imageName: 'sencho:latest',
        dataDirHost: '/opt/sencho/data',
        hostBindMounts: [{ source: '/etc/extra', destination: '/etc/extra' }],
      },
      COMPOSE,
    );
    expect(args).toEqual([
      'run', '--rm',
      '--user', 'root',
      '--entrypoint', 'sh',
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', '/opt/sencho:/opt/sencho:ro',
      '-v', '/opt/sencho/data:/app/data:rw',
      '-v', '/etc/extra:/etc/extra:ro',
      '-w', '/opt/sencho',
      'sencho:latest',
      '-c', COMPOSE,
    ]);
  });

  it('keeps workingDir a discrete -w value and the compose command isolated behind -c', () => {
    const args = buildSelfUpdateRunArgs(
      { workingDir: '/opt/sencho', imageName: 'sencho:latest', dataDirHost: null, hostBindMounts: [] },
      COMPOSE,
    );
    expect(args[args.indexOf('-w') + 1]).toBe('/opt/sencho');
    expect(args).toContain('/opt/sencho:/opt/sencho:ro');
    // The compose command is the final element, never concatenated with a path.
    expect(args[args.length - 2]).toBe('-c');
    expect(args[args.length - 1]).toBe(COMPOSE);
  });

  it('passes operator paths with shell metacharacters as inert argv data (no shell sees them)', () => {
    // execFile spawns docker without a shell, so these survive verbatim as their
    // own argv elements and are never interpreted.
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/srv/$(touch pwned)',
        imageName: 'sencho:latest',
        dataDirHost: null,
        hostBindMounts: [{ source: '/srv/a;rm -rf b', destination: '/x' }],
      },
      COMPOSE,
    );
    expect(args).toContain('/srv/$(touch pwned):/srv/$(touch pwned):ro');
    expect(args).toContain('/srv/a;rm -rf b:/srv/a;rm -rf b:ro');
    expect(args[args.indexOf('-w') + 1]).toBe('/srv/$(touch pwned)');
  });

  it('mounts only the base volumes when there are no extra host bind mounts', () => {
    const withData = buildSelfUpdateRunArgs(
      { workingDir: '/opt/sencho', imageName: 'img', dataDirHost: '/opt/sencho/data', hostBindMounts: [] },
      COMPOSE,
    );
    // docker.sock + workingDir + data dir.
    expect(withData.filter(a => a === '-v')).toHaveLength(3);

    const withoutData = buildSelfUpdateRunArgs(
      { workingDir: '/opt/sencho', imageName: 'img', dataDirHost: null, hostBindMounts: [] },
      COMPOSE,
    );
    // docker.sock + workingDir only; the data-dir mount is omitted.
    expect(withoutData.filter(a => a === '-v')).toHaveLength(2);
    expect(withoutData.some(a => a.endsWith(':/app/data:rw'))).toBe(false);
  });

  it('does not forward a source that is already mounted', () => {
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/opt/sencho',
        imageName: 'img',
        dataDirHost: null,
        hostBindMounts: [{ source: '/var/run/docker.sock', destination: '/var/run/docker.sock' }],
      },
      COMPOSE,
    );
    expect(args.filter(a => a === '/var/run/docker.sock:/var/run/docker.sock')).toHaveLength(1);
  });

  it('skips sources nested under workingDir but keeps look-alike siblings', () => {
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/srv/app',
        imageName: 'img',
        dataDirHost: null,
        hostBindMounts: [
          { source: '/srv/app/sub', destination: '/x' },          // nested under workingDir
          { source: '/srv/app-backup/config', destination: '/y' }, // shares the prefix, not nested
        ],
      },
      COMPOSE,
    );
    // The nested path is already covered by the workingDir mount.
    expect(args).not.toContain('/srv/app/sub:/srv/app/sub:ro');
    // The sibling only shares the string prefix; the `+ '/'` guard keeps it.
    expect(args).toContain('/srv/app-backup/config:/srv/app-backup/config:ro');
  });

  it('mounts an inspected workingDir or dataDirHost bind exactly once', () => {
    // In production info.Mounts also lists the compose working dir and the
    // /app/data bind, so both arrive again in hostBindMounts. The base mounts
    // already cover them, so they must not be forwarded a second time.
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/opt/sencho',
        imageName: 'img',
        dataDirHost: '/opt/sencho/data',
        hostBindMounts: [
          { source: '/opt/sencho', destination: '/opt/sencho' },       // == workingDir
          { source: '/opt/sencho/data', destination: '/app/data' },    // == dataDirHost
        ],
      },
      COMPOSE,
    );
    // workingDir keeps its single base :ro mount; never re-forwarded.
    expect(args.filter(a => a === '/opt/sencho:/opt/sencho:ro')).toHaveLength(1);
    // data dir stays mounted once as :rw at /app/data, never re-added read-only.
    expect(args.filter(a => a === '/opt/sencho/data:/app/data:rw')).toHaveLength(1);
    expect(args).not.toContain('/opt/sencho/data:/opt/sencho/data:ro');
  });

  it('forwards multiple eligible bind mounts in input order', () => {
    const args = buildSelfUpdateRunArgs(
      {
        workingDir: '/opt/sencho',
        imageName: 'img',
        dataDirHost: null,
        hostBindMounts: [
          { source: '/etc/first', destination: '/etc/first' },
          { source: '/etc/second', destination: '/etc/second' },
        ],
      },
      COMPOSE,
    );
    expect(args.indexOf('/etc/first:/etc/first:ro'))
      .toBeLessThan(args.indexOf('/etc/second:/etc/second:ro'));
  });
});
