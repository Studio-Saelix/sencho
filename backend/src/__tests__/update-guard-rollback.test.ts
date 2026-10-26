import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mutable state the mocked NodeRegistry reads (same harness as
// filesystem-backup.test.ts) so FileSystemService can be constructed against
// temp directories.
const mockState = { composeDir: '' };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import {
  aggregateRollbackOverall,
  buildRollbackItems,
  describeManagedInputs,
  describeRollbackManagedInputs,
  describeStoredManagedInputs,
  storedComposeCoverage,
  type RollbackInputs,
} from '../services/updateGuard/readiness';
import type { ContainerProbe } from '../services/updateGuard/types';

const NOW = 1_750_000_000_000;

const baseInputs = (over: Partial<RollbackInputs> = {}): RollbackInputs => ({
  backup: { exists: true, timestamp: NOW - 3_600_000 },
  envSummary: { exists: true, envPresent: true, keys: ['DB_HOST', 'DB_PASS'] },
  stackHasEnv: true,
  rollbackTarget: { target: 'nginx:1.27.1', moving: false },
  lastDeployAt: NOW - 3_600_000,
  containers: [{
    name: 'app-web-1', state: 'running', health: 'healthy', exitCode: null,
    hasHealthcheck: true, restartPolicy: 'unless-stopped', mounts: ['volume app_data'],
  }],
  recoveryGeneration: { exists: false },
  policyEligibility: null,
  managedInputs: { covered: true, detail: 'Exact authored-project coverage includes 1 managed path(s).' },
  sopsKeys: null,
  ...over,
});

const itemById = (inputs: RollbackInputs, id: string) =>
  buildRollbackItems(inputs, NOW).find(i => i.id === id)!;

describe('describeManagedInputs', () => {
  const entries = [{
    relativePath: 'compose.yaml',
    dependencyKind: 'compose-root' as const,
    provenance: 'authored' as const,
    sensitivity: 'low' as const,
    absolutePath: '/x/compose.yaml',
  }];

  it('reads as covered when nothing is left out', () => {
    expect(describeManagedInputs({ coverageRefusal: null, uncapturedInputs: [], entries })).toEqual({
      covered: true,
      detail: 'Exact authored-project coverage includes 1 managed path(s).',
    });
  });

  it('names a refused capture by its reason alone, even when notes are present', () => {
    expect(describeManagedInputs({
      coverageRefusal: 'Case-colliding managed paths "A" and "a"',
      uncapturedInputs: ['ignored'],
      entries,
    })).toEqual({ covered: false, detail: 'Case-colliding managed paths "A" and "a"' });
  });

  it('lists what a partial capture leaves out and says a rollback uses the current content', () => {
    const result = describeManagedInputs({
      coverageRefusal: null,
      uncapturedInputs: ['include ../shared/base.yaml is outside the stack directory and is not captured'],
      entries,
    });
    expect(result.covered).toBe(false);
    expect(result.detail).toBe(
      '1 input(s) are not captured and a rollback uses their current content: include ../shared/base.yaml is outside the stack directory and is not captured.',
    );
  });

  it('caps a long list and counts the rest', () => {
    const uncapturedInputs = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const result = describeManagedInputs({ coverageRefusal: null, uncapturedInputs, entries });
    expect(result.detail).toContain('8 input(s) are not captured');
    expect(result.detail).toContain('n0; n1; n2; n3; n4; and 3 more.');
    expect(result.detail).not.toContain('n5');
  });
});

describe('describeStoredManagedInputs', () => {
  const entry = (relativePath: string) => ({
    relativePath,
    dependencyKind: 'compose-root' as const,
    provenance: 'authored' as const,
    state: 'present' as const,
    contentSha256: 'x',
    sizeBytes: 1,
    sensitivity: 'low' as const,
    encrypted: false,
    mode: null,
  });
  const entries = [entry('compose.yaml'), entry('.env')];

  it('reads a generation with no omissions as holding its own entries', () => {
    expect(describeStoredManagedInputs({ entries, uncapturedInputs: [] })).toEqual({
      covered: true,
      detail: 'This recovery generation holds 2 managed path(s).',
    });
  });

  it('treats a generation written before omissions were recorded as having none', () => {
    expect(describeStoredManagedInputs({ entries }).covered).toBe(true);
  });

  it('lists what the stored generation left out, with the same cap as the live read', () => {
    const uncapturedInputs = Array.from({ length: 7 }, (_, i) => `n${i}`);
    const result = describeStoredManagedInputs({ entries, uncapturedInputs });
    expect(result.covered).toBe(false);
    expect(result.detail).toContain('7 input(s) are not captured');
    expect(result.detail).toContain('n0; n1; n2; n3; n4; and 2 more.');
  });
});

describe('describeRollbackManagedInputs', () => {
  const entry = (relativePath: string, state: 'present' | 'tombstoned' = 'present') => ({
    relativePath,
    dependencyKind: 'compose-root' as const,
    provenance: 'authored' as const,
    state,
    contentSha256: 'x',
    sizeBytes: 1,
    sensitivity: 'low' as const,
    encrypted: false,
    mode: null,
  });
  const liveOk = { coverageRefusal: null, uncapturedInputs: [], entries: [] };

  it('counts only the paths a generation actually holds', () => {
    const stored = { entries: [entry('compose.yaml'), entry('gone.env', 'tombstoned')], uncapturedInputs: [] };
    expect(describeRollbackManagedInputs({ coverage: 'complete', stored, live: liveOk })).toEqual({
      covered: true,
      detail: 'This recovery generation holds 1 managed path(s).',
    });
  });

  it('describes the live project when no generation is current', () => {
    expect(describeRollbackManagedInputs({ coverage: null, stored: null, live: liveOk }))
      .toEqual(describeManagedInputs(liveOk));
    expect(describeRollbackManagedInputs({ coverage: null, stored: null, live: 'error' })).toBe('error');
  });

  it('describes a stored generation that omits inputs from itself, whatever the live project says', () => {
    const stored = { entries: [entry('compose.yaml')], uncapturedInputs: ['include ../x.yaml is outside the stack directory and is not captured'] };
    const result = describeRollbackManagedInputs({ coverage: 'omits_inputs', stored, live: liveOk });
    expect(result).toEqual({
      covered: false,
      detail: '1 input(s) are not captured and a rollback uses their current content: include ../x.yaml is outside the stack directory and is not captured.',
    });
  });

  it('adds that the next capture would be refused without hiding the stored coverage', () => {
    const stored = { entries: [entry('compose.yaml')], uncapturedInputs: [] };
    const live = { coverageRefusal: 'Included compose file missing.yaml is unreadable', uncapturedInputs: [], entries: [] };
    expect(describeRollbackManagedInputs({ coverage: 'complete', stored, live })).toEqual({
      covered: false,
      detail: 'This recovery generation holds 1 managed path(s). The next capture would be refused: Included compose file missing.yaml is unreadable.',
    });
  });

  it('keeps the stored description when the live read fails', () => {
    const stored = { entries: [entry('compose.yaml')], uncapturedInputs: [] };
    expect(describeRollbackManagedInputs({ coverage: 'complete', stored, live: 'error' }))
      .toEqual({ covered: true, detail: 'This recovery generation holds 1 managed path(s).' });
  });

  it('is unknown for an unreadable generation and describes the live project when coverage was not recorded', () => {
    expect(describeRollbackManagedInputs({ coverage: 'unreadable', stored: null, live: liveOk })).toBe('error');
    expect(describeRollbackManagedInputs({ coverage: 'not_recorded', stored: null, live: 'error' })).toBe('error');
  });

  it('never reports a generation that recorded nothing as covered, even when the live project is clean', () => {
    expect(describeRollbackManagedInputs({ coverage: 'not_recorded', stored: null, live: liveOk })).toEqual({
      covered: false,
      detail: 'What the current recovery generation holds was not recorded.',
    });
    const live = { coverageRefusal: null, uncapturedInputs: ['n0'], entries: [] };
    expect(describeRollbackManagedInputs({ coverage: 'not_recorded', stored: null, live })).toEqual({
      covered: false,
      detail: '1 input(s) are not captured and a rollback uses their current content: n0. What the current recovery generation holds was not recorded.',
    });
  });
});

describe('storedComposeCoverage', () => {
  const manifest = (composeLayers: string[] | undefined, entries: Array<[string, 'present' | 'tombstoned']>) => ({
    entries: entries.map(([relativePath, state]) => ({ relativePath, state })),
    invocation: { composeLayers },
  }) as unknown as Parameters<typeof storedComposeCoverage>[0];

  it('is held when the generation holds every selected layer', () => {
    expect(storedComposeCoverage(manifest(
      ['compose.yaml', 'prod.yaml'],
      [['compose.yaml', 'present'], ['prod.yaml', 'present']],
    ))).toBe('held');
  });

  it('is current_content when a selected layer was deliberately omitted', () => {
    // A shared main file is selected and pinned but its bytes stay with the
    // shared target, so the generation only has whatever is there at restore.
    expect(storedComposeCoverage(manifest(
      ['compose.yaml'],
      [['compose.yaml', 'tombstoned']],
    ))).toBe('current_content');
  });

  it('is not_recorded when the generation stored no layer set', () => {
    expect(storedComposeCoverage(manifest(undefined, [['compose.yaml', 'present']]))).toBe('not_recorded');
    expect(storedComposeCoverage(manifest([], [['compose.yaml', 'present']]))).toBe('not_recorded');
  });
});

describe('buildRollbackItems', () => {
  it.each([
    ['complete', /^Current recovery generation abc123 is available for exact restore\.$/],
    ['omits_inputs', /does not hold every input, so a restore is partial/],
    ['unreadable', /exists, but what it holds could not be read/],
    ['not_recorded', /^Current recovery generation abc123 is available\. What it holds was not recorded\.$/],
  ] as const)('words the recovery generation row for %s stored coverage', (restoreCoverage, pattern) => {
    const item = itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage },
    }), 'recovery_generation');
    expect(item.state).toBe('ready');
    expect(item.detail).toMatch(pattern);
  });

  it.each(['omits_inputs', 'unreadable', 'not_recorded'] as const)('makes no exact-restore claim for %s coverage', (restoreCoverage) => {
    const item = itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage },
    }), 'recovery_generation');
    expect(item.detail).not.toMatch(/exact restore/i);
  });

  it('does not call the compose files covered when the current generation cannot be read', () => {
    const item = itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage: 'unreadable' },
    }), 'compose_source');
    expect(item.state).toBe('unknown');
  });

  it('names the compose files in the stack directory, not every input, as covered', () => {
    const item = itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage: 'omits_inputs', composeCoverage: 'held' },
    }), 'compose_source');
    expect(item.detail).toBe('The compose files in the stack directory are covered by the current recovery generation.');
  });

  it('does not claim a shared main compose file is held', () => {
    const item = itemById(baseInputs({
      recoveryGeneration: {
        exists: true,
        shortId: 'abc123',
        restoreCoverage: 'omits_inputs',
        composeCoverage: 'current_content',
      },
    }), 'compose_source');

    expect(item.state).toBe('ready');
    expect(item.detail).toContain('it does not hold');
    expect(item.detail).toContain("reads that file's current content");
    expect(item.detail).not.toMatch(/are covered/);
  });

  it('does not claim coverage for a generation that recorded no layer set', () => {
    const item = itemById(baseInputs({
      recoveryGeneration: {
        exists: true,
        shortId: 'abc123',
        restoreCoverage: 'omits_inputs',
        composeCoverage: 'not_recorded',
      },
    }), 'compose_source');

    expect(item.state).toBe('ready');
    expect(item.detail).toContain('was not recorded');
    expect(item.detail).not.toMatch(/are covered/);
  });

  it('reports the full set of rollback readiness items', () => {
    const items = buildRollbackItems(baseInputs(), NOW);
    expect(items.map(i => i.id)).toEqual([
      'recovery_generation', 'compose_source', 'env_keys', 'previous_images', 'last_deploy', 'healthchecks',
      'policy_eligibility', 'managed_inputs', 'volume_data',
    ]);
  });

  it('marks the volume row not_covered unconditionally and names the mounts', () => {
    const item = itemById(baseInputs(), 'volume_data');
    expect(item.state).toBe('not_covered');
    expect(item.detail).toContain('not included in recovery generations');
    expect(item.detail).toContain('volume app_data');
    expect(item.detail).toMatch(/managed authored project/i);
    const noMounts = itemById(baseInputs({ containers: [] }), 'volume_data');
    expect(noMounts.state).toBe('not_covered');

    const dockerDown = itemById(baseInputs({ containers: 'error' }), 'volume_data');
    expect(dockerDown.state).toBe('not_covered');
  });

  it('exposes env coverage as names only', () => {
    const item = itemById(baseInputs(), 'env_keys');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('2 variable names');
    expect(item.detail).not.toContain('DB_HOST');
    expect(item.detail).not.toContain('DB_PASS');
  });

  it('treats a stack without an env file as covered', () => {
    const item = itemById(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: false,
    }), 'env_keys');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('no env file');
  });

  it('flags an env file the backup predates', () => {
    const item = itemById(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: true,
    }), 'env_keys');
    expect(item.state).toBe('missing');
  });

  it('marks the previous image unknown when no rollback target is known', () => {
    expect(itemById(baseInputs({ rollbackTarget: { target: null, moving: false } }), 'previous_images').state).toBe('unknown');
    expect(itemById(baseInputs({ rollbackTarget: 'error' }), 'previous_images').state).toBe('unknown');
    const known = itemById(baseInputs(), 'previous_images');
    expect(known.state).toBe('ready');
    expect(known.detail).toContain('nginx:1.27.1');
  });

  it('treats a moving tag as ready because full-stack updates retain the prior image ID', () => {
    const item = itemById(baseInputs({ rollbackTarget: { target: 'nginx:latest', moving: true } }), 'previous_images');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('moving image tag');
    expect(item.detail).toContain('nginx:latest');
    expect(item.detail).toContain('recovery window');
  });

  it('does not mistake an image literally named error for a failed preview', () => {
    const item = itemById(baseInputs({ rollbackTarget: { target: 'error', moving: false } }), 'previous_images');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('error');
  });

  it('reports last deploy and healthcheck coverage', () => {
    expect(itemById(baseInputs(), 'last_deploy').state).toBe('ready');
    expect(itemById(baseInputs({ lastDeployAt: null }), 'last_deploy').state).toBe('missing');
    expect(itemById(baseInputs(), 'healthchecks').state).toBe('ready');
    const none: ContainerProbe[] = [{
      name: 'a', state: 'running', health: null, exitCode: null,
      hasHealthcheck: false, restartPolicy: null, mounts: [],
    }];
    expect(itemById(baseInputs({ containers: none }), 'healthchecks').state).toBe('missing');
  });
});


  it('marks policy eligibility blocked and warning states', () => {
    expect(itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc', restoreCoverage: 'complete' },
      policyEligibility: 'prohibited',
    }), 'policy_eligibility').state).toBe('blocked');
    expect(itemById(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc', restoreCoverage: 'complete' },
      policyEligibility: 'eligible_with_warning',
    }), 'policy_eligibility').state).toBe('warning');
  });

  it('lets recovery_generation supersede the legacy backup slot for compose_source', () => {
    const items = buildRollbackItems(baseInputs({
      backup: { exists: false, timestamp: null },
      recoveryGeneration: { exists: true, shortId: 'deadbeefcaf0', restoreCoverage: 'complete' },
      policyEligibility: 'eligible',
    }), NOW);
    expect(items.find(i => i.id === 'compose_source')!.state).toBe('ready');
    expect(items.find(i => i.id === 'recovery_generation')!.state).toBe('ready');
  });

describe('aggregateRollbackOverall', () => {
  it('is ready when compose, env, and previous image are all covered', () => {
    expect(aggregateRollbackOverall(buildRollbackItems(baseInputs(), NOW))).toBe('ready');
  });

  it('is not_ready without a backup slot', () => {
    const items = buildRollbackItems(baseInputs({
      backup: { exists: false, timestamp: null },
      envSummary: { exists: false, envPresent: false, keys: [] },
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('not_ready');
  });

  it('is partial when the previous image tag is unknown', () => {
    const items = buildRollbackItems(baseInputs({ rollbackTarget: { target: null, moving: false } }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('partial');
  });

  it('is ready when the rollback target is a moving tag (image ID capture covers it)', () => {
    const items = buildRollbackItems(baseInputs({ rollbackTarget: { target: 'nginx:latest', moving: true } }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('ready');
  });

  it('is partial when env coverage is missing', () => {
    const items = buildRollbackItems(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: true,
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('partial');
  });

  it('never gates on the volume or healthcheck disclosures', () => {
    const items = buildRollbackItems(baseInputs({ containers: 'error' }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('ready');
  });

  it.each(['omits_inputs', 'not_recorded'] as const)(
    'is partial when the generation coverage is %s, so the overall state never contradicts the rows',
    (restoreCoverage) => {
      const items = buildRollbackItems(baseInputs({
        recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage },
        policyEligibility: 'eligible',
        managedInputs: { covered: false, detail: 'Stored generation is partial or unrecorded.' },
      }), NOW);
      expect(items.find(i => i.id === 'managed_inputs')!.state).toBe('warning');
      expect(aggregateRollbackOverall(items)).toBe('partial');
    },
  );

  it('stays ready when the generation recorded complete coverage', () => {
    const items = buildRollbackItems(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage: 'complete' },
      policyEligibility: 'eligible',
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('ready');
  });

  it('leaves an unreadable generation to its existing partial result', () => {
    const items = buildRollbackItems(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc123', restoreCoverage: 'unreadable' },
      policyEligibility: 'eligible',
      managedInputs: 'error',
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('partial');
  });

  it.each(['error', null] as const)(
    'is partial when managed input coverage is %s, so an unread coverage claim is never Ready',
    (managedInputs) => {
      const items = buildRollbackItems(baseInputs({ managedInputs }), NOW);
      expect(items.find(i => i.id === 'managed_inputs')!.state).toBe('unknown');
      expect(aggregateRollbackOverall(items)).toBe('partial');
    },
  );
  it('is not_ready when policy eligibility is blocked', () => {
    const items = buildRollbackItems(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc', restoreCoverage: 'complete' },
      policyEligibility: 'prohibited',
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('not_ready');
  });

  it('is at best partial when policy eligibility is warning or unknown', () => {
    const warn = buildRollbackItems(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc', restoreCoverage: 'complete' },
      policyEligibility: 'eligible_with_warning',
    }), NOW);
    expect(aggregateRollbackOverall(warn)).toBe('partial');
    const unk = buildRollbackItems(baseInputs({
      recoveryGeneration: { exists: true, shortId: 'abc', restoreCoverage: 'complete' },
      policyEligibility: 'unknown',
    }), NOW);
    expect(aggregateRollbackOverall(unk)).toBe('partial');
  });

  it('surfaces blocked repository secrets and gates overall readiness', () => {
    const item = itemById(baseInputs({
      sopsKeys: {
        ready: false,
        detail: 'Rollback restore needs age recipient(s) that are not on this node: age1example',
      },
    }), 'sops_keys');
    expect(item.state).toBe('blocked');
    expect(item.detail).toContain('age1example');
    expect(item.detail).not.toMatch(/AGE-SECRET-KEY/);
    expect(aggregateRollbackOverall(buildRollbackItems(baseInputs({
      sopsKeys: { ready: false, detail: 'missing key' },
    }), NOW))).toBe('not_ready');
  });

  it('omits the repository secrets row when not Git-managed', () => {
    const items = buildRollbackItems(baseInputs({ sopsKeys: null }), NOW);
    expect(items.some((item) => item.id === 'sops_keys')).toBe(false);
  });

});

describe('FileSystemService.getBackupEnvSummary', () => {
  let tmpDir: string;
  let composeDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-envsum-'));
    composeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-envsum-compose-'));
    mockState.composeDir = composeDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(composeDir, { recursive: true, force: true });
  });

  async function getService() {
    const { FileSystemService } = await import('../services/FileSystemService');
    return FileSystemService.getInstance();
  }

  function writeBackupEnv(stackName: string, content: string | null) {
    const dir = path.join(tmpDir, 'backups', '1', stackName);
    fs.mkdirSync(dir, { recursive: true });
    if (content !== null) fs.writeFileSync(path.join(dir, '.env'), content, 'utf-8');
  }

  it('returns key names only, never values', async () => {
    writeBackupEnv('web', 'DB_HOST=db.internal\nDB_PASS=s3cret-value\n# comment\nEMPTY=\n  INDENTED=ok\nnot a var line\n');
    const svc = await getService();
    const summary = await svc.getBackupEnvSummary('web');
    expect(summary).toEqual({
      exists: true,
      envPresent: true,
      keys: ['DB_HOST', 'DB_PASS', 'EMPTY', 'INDENTED'],
    });
    expect(JSON.stringify(summary)).not.toContain('s3cret-value');
    expect(JSON.stringify(summary)).not.toContain('db.internal');
  });

  it('reports a backup without an env file', async () => {
    writeBackupEnv('web', null);
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('web')).toEqual({ exists: true, envPresent: false, keys: [] });
  });

  it('reports a missing backup slot', async () => {
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('web')).toEqual({ exists: false, envPresent: false, keys: [] });
  });

  it('rejects traversal-shaped stack names without touching the filesystem', async () => {
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('../../etc')).toEqual({ exists: false, envPresent: false, keys: [] });
    expect(await svc.getBackupEnvSummary('..')).toEqual({ exists: false, envPresent: false, keys: [] });
  });

  it('propagates a non-ENOENT env read failure instead of reporting "no env in backup"', async () => {
    // An unreadable .env (here: a directory, EISDIR) must throw so callers
    // degrade the item to unknown rather than falsely claiming the backup
    // contains no env file.
    const dir = path.join(tmpDir, 'backups', '1', 'web');
    fs.mkdirSync(path.join(dir, '.env'), { recursive: true });
    const svc = await getService();
    await expect(svc.getBackupEnvSummary('web')).rejects.toThrow();
  });
});
