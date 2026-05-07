/**
 * Pins the argument vector TrivyService sends to `trivy config`.
 *
 * `trivy config` is a distinct subcommand from `trivy image` and does not
 * accept `--no-progress`. If the arg vector grows a flag the subcommand
 * rejects, every stack configuration scan fails with a fatal Trivy error.
 * This test locks the vector so the bug cannot quietly return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ExecFileCall {
  file: string;
  args: string[];
}

const execFileCalls: ExecFileCall[] = [];
let nextTrivyStdout = JSON.stringify({ Results: [] });
// Tests can install a Promise to gate the next execFile resolution. The
// dedup tests use this to keep the first scan in flight while issuing a
// second concurrent call, so the in-progress flag is observable.
let pendingExecGate: Promise<void> | null = null;
let nextExecShouldFail = false;

vi.mock('child_process', () => {
  // TrivyService wraps this with `promisify(execFile)` at module load. The
  // custom promisify symbol is what tells util.promisify to return
  // `{stdout, stderr}` rather than a single value, so we install our async
  // double there.
  const execFile = () => undefined;
  (execFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = async (file: string, args: string[]) => {
    execFileCalls.push({ file, args });
    if (pendingExecGate) await pendingExecGate;
    if (nextExecShouldFail) {
      nextExecShouldFail = false;
      throw new Error('simulated trivy failure');
    }
    return { stdout: nextTrivyStdout, stderr: '' };
  };
  return { execFile };
});

interface UpdateCall {
  id: number;
  patch: Record<string, unknown>;
}
interface MisconfigInsert {
  scanId: number;
  count: number;
  findings: Array<Record<string, unknown>>;
}

const createdScans: Array<Record<string, unknown>> = [];
const updateCalls: UpdateCall[] = [];
const misconfigInserts: MisconfigInsert[] = [];

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getRegistries: () => [],
      createVulnerabilityScan: (scan: Record<string, unknown>) => {
        createdScans.push(scan);
        return 42;
      },
      updateVulnerabilityScan: (id: number, patch: Record<string, unknown>) => {
        updateCalls.push({ id, patch });
      },
      insertMisconfigFindings: (scanId: number, findings: Array<Record<string, unknown>>) => {
        misconfigInserts.push({ scanId, count: findings.length, findings });
      },
      getVulnerabilityScan: (id: number) => ({
        id,
        node_id: 1,
        image_ref: 'stack:test-stack',
        scanned_at: Date.now(),
        total_vulnerabilities: 0,
        critical_count: 0,
        high_count: 0,
        medium_count: 0,
        low_count: 0,
        unknown_count: 0,
        fixable_count: 0,
        secret_count: 0,
        misconfig_count: 0,
        highest_severity: null,
        trivy_version: '0.50.0',
        status: 'completed',
      }),
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/fake/compose',
      hasComposeFile: async () => true,
    }),
  },
}));

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      resolveDockerConfig: async () => ({ config: {}, warnings: [] }),
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        getImage: () => ({ inspect: async () => ({}) }),
      }),
    }),
  },
}));

vi.mock('../services/TrivyInstaller', () => ({
  default: {
    getInstance: () => ({
      binaryPath: () => '/fake/managed/trivy',
      cacheDir: () => '/tmp/trivy-cache',
    }),
  },
}));

import TrivyService from '../services/TrivyService';

interface TrivyServiceInternals {
  binaryPath: string | null;
  version: string | null;
  source: string;
}

function forceBinary(svc: TrivyService): void {
  const internals = svc as unknown as TrivyServiceInternals;
  internals.binaryPath = '/fake/trivy';
  internals.version = '0.50.0';
  internals.source = 'managed';
}

describe('TrivyService.scanComposeStack arg vector', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    createdScans.length = 0;
    updateCalls.length = 0;
    misconfigInserts.length = 0;
    nextTrivyStdout = JSON.stringify({ Results: [] });
    forceBinary(TrivyService.getInstance());
  });

  it('invokes `trivy config` without the unsupported `--no-progress` flag', async () => {
    await TrivyService.getInstance().scanComposeStack(1, 'test-stack', 'manual');

    expect(execFileCalls.length).toBe(1);
    const args = execFileCalls[0].args;
    expect(args).not.toContain('--no-progress');
  });

  it('pins the exact argument order so future edits cannot reintroduce the bug', async () => {
    await TrivyService.getInstance().scanComposeStack(1, 'test-stack', 'manual');

    const call = execFileCalls[0];
    expect(call.file).toBe('/fake/trivy');
    expect(call.args.length).toBe(5);
    expect(call.args[0]).toBe('config');
    expect(call.args[1]).toBe('--format');
    expect(call.args[2]).toBe('json');
    expect(call.args[3]).toBe('--quiet');
    // Last arg is the resolved stack path; assert shape rather than exact
    // value so the test works across local and CI path separators.
    expect(call.args[4]).toContain('test-stack');
  });

  it('persists the scan row with scanners_used=config', async () => {
    await TrivyService.getInstance().scanComposeStack(1, 'test-stack', 'manual');

    expect(createdScans.length).toBe(1);
    expect(createdScans[0].image_ref).toBe('stack:test-stack');
    expect(createdScans[0].scanners_used).toBe('config');
    expect(createdScans[0].triggered_by).toBe('manual');
  });

  it('rejects stack names that traverse outside the compose directory', async () => {
    await expect(
      TrivyService.getInstance().scanComposeStack(1, '../evil', 'manual'),
    ).rejects.toThrow(/Invalid stack path/);
    expect(execFileCalls.length).toBe(0);
  });

  it('marks the scan row completed on a successful run', async () => {
    await TrivyService.getInstance().scanComposeStack(1, 'test-stack', 'manual');

    // Two updates expected: one to record the results + status=completed,
    // and no failure update on the success path.
    const completed = updateCalls.find((u) => u.patch.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.id).toBe(42);
    expect(updateCalls.some((u) => u.patch.status === 'failed')).toBe(false);
  });

  it('tallies misconfig severities and rolls up highest_severity', async () => {
    nextTrivyStdout = JSON.stringify({
      Results: [
        {
          Target: 'docker-compose.yml',
          Misconfigurations: [
            { ID: 'DS001', Severity: 'CRITICAL', Title: 'Privileged mode' },
            { ID: 'DS002', Severity: 'HIGH', Title: 'Running as root' },
            { ID: 'DS003', Severity: 'MEDIUM', Title: 'Missing healthcheck' },
          ],
        },
      ],
    });

    await TrivyService.getInstance().scanComposeStack(1, 'test-stack', 'manual');

    const completed = updateCalls.find((u) => u.patch.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.patch.critical_count).toBe(1);
    expect(completed?.patch.high_count).toBe(1);
    expect(completed?.patch.medium_count).toBe(1);
    expect(completed?.patch.low_count).toBe(0);
    expect(completed?.patch.unknown_count).toBe(0);
    expect(completed?.patch.misconfig_count).toBe(3);
    expect(completed?.patch.highest_severity).toBe('CRITICAL');

    expect(misconfigInserts.length).toBe(1);
    expect(misconfigInserts[0].scanId).toBe(42);
    expect(misconfigInserts[0].count).toBe(3);
  });
});

describe('TrivyService.scanComposeStack dedup', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    createdScans.length = 0;
    updateCalls.length = 0;
    misconfigInserts.length = 0;
    nextTrivyStdout = JSON.stringify({ Results: [] });
    pendingExecGate = null;
    nextExecShouldFail = false;
    forceBinary(TrivyService.getInstance());
  });

  it('reports isScanningStack=false before any scan starts', () => {
    expect(TrivyService.getInstance().isScanningStack(1, 'unscanned')).toBe(false);
  });

  it('rejects a concurrent scan of the same stack while the first is in flight', async () => {
    let release: (() => void) | null = null;
    pendingExecGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = TrivyService.getInstance().scanComposeStack(1, 'gated-stack', 'manual');
    // Yield twice so the inner async setup (path resolve + dedup add) runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(TrivyService.getInstance().isScanningStack(1, 'gated-stack')).toBe(true);

    await expect(
      TrivyService.getInstance().scanComposeStack(1, 'gated-stack', 'manual'),
    ).rejects.toThrow(/Already scanning this stack/);

    release!();
    await first;
    expect(TrivyService.getInstance().isScanningStack(1, 'gated-stack')).toBe(false);
    // Only one trivy invocation should have happened — the second was
    // rejected before it ever reached execFile.
    expect(execFileCalls.length).toBe(1);
  });

  it('allows different stacks on the same node to scan in parallel', async () => {
    const r1 = TrivyService.getInstance().scanComposeStack(1, 'stack-a', 'manual');
    const r2 = TrivyService.getInstance().scanComposeStack(1, 'stack-b', 'manual');
    await Promise.all([r1, r2]);
    expect(execFileCalls.length).toBe(2);
    expect(TrivyService.getInstance().isScanningStack(1, 'stack-a')).toBe(false);
    expect(TrivyService.getInstance().isScanningStack(1, 'stack-b')).toBe(false);
  });

  it('allows the same stack to scan again on a different node', async () => {
    const r1 = TrivyService.getInstance().scanComposeStack(1, 'shared-name', 'manual');
    const r2 = TrivyService.getInstance().scanComposeStack(2, 'shared-name', 'manual');
    await Promise.all([r1, r2]);
    expect(execFileCalls.length).toBe(2);
  });

  it('releases the dedup key after a failed scan so retry works', async () => {
    nextExecShouldFail = true;
    await expect(
      TrivyService.getInstance().scanComposeStack(1, 'fail-stack', 'manual'),
    ).rejects.toThrow(/simulated trivy failure/);
    expect(TrivyService.getInstance().isScanningStack(1, 'fail-stack')).toBe(false);

    // Subsequent scan after release should succeed.
    await TrivyService.getInstance().scanComposeStack(1, 'fail-stack', 'manual');
    expect(execFileCalls.length).toBe(2);
  });
});
