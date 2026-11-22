/**
 * An atomic deploy that a data restore's directory fence refuses (or a policy
 * block stops) before Compose has been handed the `up` leaves the stack's
 * recovery points exactly as they were: its own candidate is abandoned, the
 * previous rollback point stays current and `active`, nothing is left for the
 * reconcile sweep to flag as stuck, no compensation runs, and the refusal
 * leaves the deploy as itself. The handoff, which supersedes the previous
 * point, comes only after the up's admission and the legacy-orphan lookup.
 *
 * Real: the database and its generation transitions (`handoff`,
 * `markReconciling`, `abandon`), the stack files, the link walk, the Compose
 * file selection and the admission. Stand-ins: `child_process.spawn` (a call
 * means Docker Compose was started), the fence store's list of held
 * directories, the Docker daemon, and `captureCandidate`, which inserts the
 * candidate row the real capture would without needing a daemon to inspect.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  args: readonly string[];
}

const spawned: FakeChild[] = [];

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      child.args = args;
      spawned.push(child);
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{"services":{}}'));
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

const STACK = 'app';
const PREVIOUS = 'prev-point';
const CANDIDATE = 'new-candidate';

let tmpDir: string;
let nodeId: number;
let composeDir: string;
let stackDir: string;
let fenced: string;
let fences: Array<{ senchoPath: string; hostPath: string; aliases: string[] }>;

type ComposeServiceType = import('../services/ComposeService').ComposeService;
type Modules = {
  ComposeService: typeof import('../services/ComposeService').ComposeService;
  DockerController: typeof import('../services/DockerController').default;
  DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
  StackUpdateRecoveryService: typeof import('../services/StackUpdateRecoveryService').StackUpdateRecoveryService;
  RestoreFenceStore: typeof import('../services/recovery/restoreFence').RestoreFenceStore;
  fsWorkInFlightCountForTests: typeof import('../services/recovery/restoreFence').fsWorkInFlightCountForTests;
  isDataRestoreFenceError: typeof import('../helpers/dataRestoreFenceError').isDataRestoreFenceError;
  SelfIdentityService: typeof import('../services/SelfIdentityService').default;
  DriftLedgerService: typeof import('../services/DriftLedgerService').DriftLedgerService;
};
let m: Modules;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const { NodeRegistry } = await import('../services/NodeRegistry');
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  composeDir = await fsPromises.realpath(process.env.COMPOSE_DIR as string);
  m = {
    ComposeService: (await import('../services/ComposeService')).ComposeService,
    DockerController: (await import('../services/DockerController')).default,
    DatabaseService: (await import('../services/DatabaseService')).DatabaseService,
    StackUpdateRecoveryService: (await import('../services/StackUpdateRecoveryService')).StackUpdateRecoveryService,
    RestoreFenceStore: (await import('../services/recovery/restoreFence')).RestoreFenceStore,
    fsWorkInFlightCountForTests: (await import('../services/recovery/restoreFence')).fsWorkInFlightCountForTests,
    isDataRestoreFenceError: (await import('../helpers/dataRestoreFenceError')).isDataRestoreFenceError,
    SelfIdentityService: (await import('../services/SelfIdentityService')).default,
    DriftLedgerService: (await import('../services/DriftLedgerService')).DriftLedgerService,
  };
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function generationRow(id: string, over: Record<string, unknown>) {
  const now = Date.now();
  return {
    id, node_id: nodeId, stack_name: STACK, status: 'candidate', phase: 'captured', is_current: 0,
    backup_slot_id: null, content_path: null, operation_kind: 'deployment', override_path: null,
    services_json: '[]', health_gate_id: null, gate_retain_until: null, artifact_expires_at: null,
    operation_lease_expires_at: now + 60_000, created_at: now, updated_at: now,
    created_by: 'atomic-deploy', artifacts_retired: 0, released_at: null, released_by: null,
    ...over,
  };
}

/** The `pull` and `up` commands Compose was started with (the preliminary renders are not). */
function composeMutations(): string[] {
  return spawned.map((c) => c.args.join(' ')).filter((a) => /\b(pull|up)\b/.test(a));
}

function db() {
  return m.DatabaseService.getInstance();
}

function rowOf(id: string) {
  return db().getStackUpdateRecoveryGeneration(id);
}

function holdFence(dir: string = fenced): void {
  fences.splice(0, fences.length, { senchoPath: dir, hostPath: dir, aliases: [] });
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return null;
}

/** What a recovery point that is left behind would show an operator. */
function expectPreviousPointUntouched() {
  const prev = rowOf(PREVIOUS);
  expect(prev?.status).toBe('active');
  expect(prev?.is_current).toBe(1);
  expect(db().getCurrentStackUpdateRecovery(nodeId, STACK)?.id).toBe(PREVIOUS);
  const candidate = rowOf(CANDIDATE);
  expect(candidate?.status).toBe('abandoned');
  expect(candidate?.is_current).toBe(0);
  // Once its lease lapses, nothing about the candidate is flagged as stuck.
  const farFuture = Date.now() + 24 * 60 * 60 * 1000;
  expect(db().listStuckStackUpdateRecoveryGenerations(farFuture).filter((r) => r.stack_name === STACK)).toEqual([]);
}

beforeEach(async () => {
  spawned.length = 0;
  fenced = path.join(composeDir, STACK, 'data');
  stackDir = path.join(composeDir, STACK);
  await fsPromises.rm(stackDir, { recursive: true, force: true });
  await fsPromises.mkdir(fenced, { recursive: true });
  await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
  // The override is a readable link into the directory a restore overwrites.
  await fsPromises.writeFile(path.join(fenced, 'compose.override.yml'), 'services: {}\n');
  await fsPromises.symlink(path.join('data', 'compose.override.yml'), path.join(stackDir, 'compose.override.yml'));
  fences = [];
  vi.spyOn(m.SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
  vi.spyOn(m.RestoreFenceStore.getInstance(), 'liveFencedFsTargets').mockImplementation(() => fences);

  db().getDb().prepare('DELETE FROM stack_update_recovery_generations').run();
  db().insertStackUpdateRecoveryGeneration(generationRow(PREVIOUS, {
    status: 'active', phase: 'immediate_verified', is_current: 1, operation_kind: 'update',
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of spawned) child.emit('close', 0);
});

/** Stand-ins around the deploy that need no Docker daemon. */
function harness(over: { fenceAtCapture?: boolean } = {}) {
  const svc: ComposeServiceType = m.ComposeService.getInstance(nodeId);
  const inner = svc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  vi.spyOn(inner, 'assertSopsOverlayOrRefuse').mockResolvedValue(undefined);
  vi.spyOn(inner, 'ensureExternalNetworksForDeploy').mockResolvedValue(undefined);
  vi.spyOn(inner, 'noteComposeVersionSkew').mockResolvedValue(undefined);
  vi.spyOn(inner, 'supersedeGatesForContainerOp').mockResolvedValue(undefined);
  vi.spyOn(inner, 'retireStaleServiceRecoveries').mockResolvedValue(undefined);
  vi.spyOn(inner, 'refreshExposureCache').mockResolvedValue(undefined);
  vi.spyOn(svc, 'evaluateDockerEndpoint').mockResolvedValue(null);
  vi.spyOn(m.DriftLedgerService.getInstance(), 'recordBaseline').mockResolvedValue(undefined as never);
  vi.spyOn(m.DriftLedgerService.getInstance(), 'reconcileStack').mockResolvedValue(undefined as never);
  // DockerController.getInstance builds a new controller per call, so the
  // stand-ins sit on the prototype.
  const dockerController = m.DockerController.prototype;
  vi.spyOn(dockerController, 'getDocker').mockReturnValue({ listContainers: async () => [] } as never);
  const removed = vi.spyOn(dockerController, 'removeContainers').mockResolvedValue([]);

  const recovery = m.StackUpdateRecoveryService.getInstance();
  vi.spyOn(recovery, 'captureCandidate').mockImplementation(async () => {
    const row = generationRow(CANDIDATE, {});
    db().insertStackUpdateRecoveryGeneration(row as never);
    if (over.fenceAtCapture) holdFence();
    return row as never;
  });
  const compensate = vi.spyOn(recovery, 'compensateWithCandidate').mockResolvedValue(true);
  const begin = vi.spyOn(svc as unknown as { beginGitOpsDeploy: () => null }, 'beginGitOpsDeploy').mockReturnValue(null);
  return { svc, inner, removed, compensate, begin, dockerController };
}

describe('an atomic deploy refused before Compose is handed its up leaves the previous rollback point current', () => {
  it('refuses at the up admission after the verification pull, and abandons the candidate it captured', async () => {
    const { svc, removed, compensate, begin } = harness();
    const execute = vi.spyOn(svc as unknown as { execute: () => Promise<void> }, 'execute').mockResolvedValue(undefined);
    const error = await refusal(svc.deployStack(STACK, undefined, true, undefined, {
      pullServices: ['web'],
      pullRefs: [],
      // The fence is recorded while the deploy verifies what it pulled.
      verifyPulled: async () => { holdFence(); },
    }));
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expectPreviousPointUntouched();
    expect(compensate).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('refuses at the verification pull\'s own spawn admission, with the pull never started', async () => {
    const { svc, compensate } = harness();
    const realExecute = (svc as unknown as { execute: (...a: unknown[]) => Promise<void> }).execute.bind(svc);
    // The fence lands in the moment between the capture and the pull's spawn.
    vi.spyOn(svc as unknown as { execute: (...a: unknown[]) => Promise<void> }, 'execute')
      .mockImplementation(async (...args: unknown[]) => { holdFence(); return realExecute(...args); });
    const error = await refusal(svc.deployStack(STACK, undefined, true, undefined, {
      pullServices: ['web'],
      pullRefs: [],
    }));
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(composeMutations()).toEqual([]);
    expectPreviousPointUntouched();
    expect(compensate).not.toHaveBeenCalled();
  });

  it('refuses an up argv that names a file a fence recorded after the capture holds', async () => {
    const { svc, compensate, begin } = harness({ fenceAtCapture: true });
    const error = await refusal(svc.deployStack(STACK, undefined, true));
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(composeMutations()).toEqual([]);
    expectPreviousPointUntouched();
    expect(compensate).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it('refuses a deploy a policy block stopped at the verification step, the same way', async () => {
    const { svc, compensate } = harness();
    vi.spyOn(svc as unknown as { execute: () => Promise<void> }, 'execute').mockResolvedValue(undefined);
    const blocked = Object.assign(new Error('blocked by policy'), { name: 'PulledCandidateBlockedError' });
    const error = await refusal(svc.deployStack(STACK, undefined, true, undefined, {
      pullServices: ['web'],
      pullRefs: [],
      verifyPulled: async () => { throw blocked; },
    }));
    expect(error).toBe(blocked);
    expectPreviousPointUntouched();
    expect(compensate).not.toHaveBeenCalled();
  });

  it('refuses at the legacy-orphan lookup\'s own `compose ps` with no Compose error logged, no orphan removed and no GitOps record', async () => {
    const { svc, dockerController, removed, compensate, begin } = harness();
    vi.spyOn(svc as unknown as { execute: () => Promise<void> }, 'execute').mockResolvedValue(undefined);
    // A fence recorded after the up's admission and before the lookup's own.
    vi.spyOn(dockerController as unknown as { isStackDirectoryAbsent: () => Promise<boolean> }, 'isStackDirectoryAbsent')
      .mockImplementation(async () => { holdFence(); return false; });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = await refusal(svc.deployStack(STACK, undefined, true));
    expect(m.isDataRestoreFenceError(error), String(error)).toBe(true);
    expect(errorLog.mock.calls.some((call) => String(call[0]).includes('Docker Compose Error'))).toBe(false);
    expect(composeMutations()).toEqual([]);
    expect(removed).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expectPreviousPointUntouched();
    expect(compensate).not.toHaveBeenCalled();
    expect(m.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('hands the candidate off only after the up is admitted, and supersedes the previous point when the deploy runs', async () => {
    const { svc } = harness();
    const events: string[] = [];
    const recovery = m.StackUpdateRecoveryService.getInstance();
    const realHandoff = recovery.handoff.bind(recovery);
    vi.spyOn(recovery, 'handoff').mockImplementation((...args) => {
      events.push('handoff');
      return realHandoff(...args);
    });
    vi.spyOn(svc as unknown as { execute: (c: string, a: string[]) => Promise<void> }, 'execute')
      .mockImplementation(async (_c, args) => { events.push(args.includes('up') ? 'up' : 'pull'); });
    await svc.deployStack(STACK, undefined, true, undefined, {
      pullServices: ['web'],
      pullRefs: [],
      verifyPulled: async () => { events.push('verified'); },
    });
    expect(events).toEqual(['pull', 'verified', 'handoff', 'up']);
    expect(rowOf(CANDIDATE)?.status).toBe('active');
    expect(rowOf(CANDIDATE)?.is_current).toBe(1);
    expect(rowOf(PREVIOUS)?.status).toBe('superseded');
  });
});
