import type Docker from 'dockerode';
import { getRegisteredEngines, registerBackupEngine } from '../capability';
import { RecoveryEngineService } from '../operationRunner';
import DockerController from '../../../services/DockerController';
import { inspectHelperImage, resolveHelperImageRef, type HelperImageRef } from './helperImage';
import { RESTIC_ENGINE_ID, ResticEngine } from './ResticEngine';
import { RECOVERY_CONTRACT_VERSION } from '../types';
import type {
  BackupEngine,
  CreatePointRequest,
  EngineExecutionContext,
  EngineProbe,
  EngineResult,
  IntegrityMethod,
  PointCaptureEvidence,
  RecoveryPoint,
  RestoreEvidence,
  RestoreIntent,
  StorageKind,
} from '../types';

/**
 * The engine the registry holds.
 *
 * It exists so this build advertises volume protection and so `probe()` can
 * answer without a request. It never captures, checks or restores: those run on
 * the per-operation engine the operation runner builds, because they need the
 * repository password and it must live for exactly one run. Calling an operation
 * here is a programming error, and it fails closed rather than pretending.
 */
class RegisteredResticEngine implements BackupEngine {
  readonly engineId = RESTIC_ENGINE_ID;
  readonly contractVersion = RECOVERY_CONTRACT_VERSION;
  readonly storageKinds: readonly StorageKind[] = ['named_volume'];

  constructor(
    private readonly docker: Docker,
    private readonly configured: HelperImageRef,
  ) {}

  async probe(): Promise<EngineProbe> {
    const state = await inspectHelperImage(this.docker, this.configured);
    return {
      engineId: this.engineId,
      build: this.configured.kind === 'pinned' ? this.configured.ref : '',
      usable: state.state === 'present',
    };
  }

  async createPoint(
    _request: CreatePointRequest,
    _ctx: EngineExecutionContext,
  ): Promise<EngineResult<PointCaptureEvidence>> {
    return { ok: false, errorClass: 'internal' };
  }

  async verifyPoint(
    _point: Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>,
    _method: IntegrityMethod,
    _ctx: EngineExecutionContext,
  ): Promise<EngineResult<{ result: 'verified' | 'mismatch' }>> {
    return { ok: false, errorClass: 'internal' };
  }

  async restore(_intent: RestoreIntent, _ctx: EngineExecutionContext): Promise<EngineResult<RestoreEvidence>> {
    return { ok: false, errorClass: 'internal' };
  }
}

/**
 * Register the volume-protection engine and the health function the descriptor
 * reads. Called once, at startup, after the recovery schema is confirmed current.
 */
export function registerResticEngine(nodeId: number): void {
  const service = RecoveryEngineService.getInstance(nodeId);
  const docker = DockerController.getInstance(nodeId).getDocker();
  if (getRegisteredEngines().length > 0) return;
  registerBackupEngine(
    new RegisteredResticEngine(docker, resolveHelperImageRef()),
    () => service.health(),
  );
}

/** Re-exported so startup does not have to know the engine class. */
export { ResticEngine };
