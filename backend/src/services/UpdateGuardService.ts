import si from 'systeminformation';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { ComposeDoctorService } from './ComposeDoctorService';
import { UpdatePreviewService } from './UpdatePreviewService';
import { withTimeout } from '../utils/withTimeout';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import {
  aggregateRollbackOverall,
  aggregateVerdict,
  backupSlotSignal,
  buildRollbackItems,
  containersSignal,
  diskSignal,
  driftSignal,
  healthchecksSignal,
  preflightSignal,
  updatePreviewSignal,
  type Errored,
} from './updateGuard/readiness';
import type { ContainerProbe, RollbackReadinessReport, UpdateReadinessReport } from './updateGuard/types';

// Bound on the network-and-socket-backed inputs (container probe, update
// preview, disk stats) so a hung registry or Docker socket cannot stall the
// report past the dialog's own fetch timeout; the remaining inputs are local
// DB/file reads. A timed-out input degrades to its 'unknown' signal instead
// of failing the report.
const INPUT_TIMEOUT_MS = 3_000;

/**
 * Computes update readiness and rollback readiness for a stack, on demand,
 * from existing per-feature stores (preflight runs, drift findings, the atomic
 * backup slot, the update preview, live Docker state). Derived data only;
 * nothing here is persisted.
 */
export class UpdateGuardService {
  private static instance: UpdateGuardService;

  public static getInstance(): UpdateGuardService {
    if (!UpdateGuardService.instance) {
      UpdateGuardService.instance = new UpdateGuardService();
    }
    return UpdateGuardService.instance;
  }

  /**
   * Probe the stack's containers via the compose project label, normalized for
   * the pure scoring functions. Throws on Docker errors; callers map that to
   * the 'error' sentinel.
   */
  async probeContainers(nodeId: number, stackName: string): Promise<ContainerProbe[]> {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${stackName}`] },
    });
    const probes = await Promise.all(
      listed.map(async (info): Promise<ContainerProbe | null> => {
        const name = info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12);
        let inspect: Awaited<ReturnType<ReturnType<typeof docker.getContainer>['inspect']>>;
        try {
          inspect = await docker.getContainer(info.Id).inspect();
        } catch (e: unknown) {
          // A container removed between list and inspect (auto-heal or update
          // churn) should not collapse the whole probe; skip just that one.
          if ((e as { statusCode?: number })?.statusCode === 404) return null;
          throw e;
        }
        const mounts = (inspect.Mounts ?? []).map(m =>
          m.Type === 'volume' ? `volume ${m.Name ?? 'unnamed'}` : `${m.Type} ${m.Source ?? ''}`.trim(),
        );
        return {
          name,
          state: inspect.State?.Status ?? info.State ?? 'unknown',
          health: inspect.State?.Health?.Status ?? null,
          exitCode: typeof inspect.State?.ExitCode === 'number' ? inspect.State.ExitCode : null,
          hasHealthcheck: !!inspect.Config?.Healthcheck?.Test?.length,
          restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || null,
          mounts,
        };
      }),
    );
    return probes.filter((p): p is ContainerProbe => p !== null);
  }

  async computeUpdateReadiness(nodeId: number, stackName: string): Promise<UpdateReadinessReport> {
    const db = DatabaseService.getInstance();
    const now = Date.now();

    const [preflight, drift, containers, preview, backup, disk] = await Promise.all([
      this.collect('preflight', stackName, async () => ComposeDoctorService.getInstance().getLatest(nodeId, stackName)),
      this.collect('drift', stackName, async () => db.getOpenDriftFindings(nodeId, stackName).length),
      this.collect('containers', stackName, () =>
        withTimeout(this.probeContainers(nodeId, stackName), INPUT_TIMEOUT_MS, 'readiness container probe')),
      this.collect('update preview', stackName, () =>
        withTimeout(UpdatePreviewService.getInstance().getPreview(nodeId, stackName), INPUT_TIMEOUT_MS, 'readiness update preview')),
      this.collect('backup info', stackName, () => FileSystemService.getInstance(nodeId).getBackupInfo(stackName)),
      this.collect('disk', stackName, () => this.readDiskUsage()),
    ]);

    const settings = db.getGlobalSettings();
    const limitPercent = parseInt(settings['host_disk_limit'] ?? '90', 10) || 90;

    const signals = [
      preflightSignal(preflight),
      driftSignal(drift),
      containersSignal(containers),
      healthchecksSignal(containers),
      updatePreviewSignal(preview === 'error' ? 'error' : preview.summary),
      backupSlotSignal(backup, now),
      diskSignal(typeof disk === 'number' ? { usePercent: disk, limitPercent } : 'error'),
    ];

    return { stack: stackName, computedAt: now, verdict: aggregateVerdict(signals), signals };
  }

  async computeRollbackReadiness(nodeId: number, stackName: string): Promise<RollbackReadinessReport> {
    const db = DatabaseService.getInstance();
    const fsSvc = FileSystemService.getInstance(nodeId);
    const now = Date.now();

    const [backup, envSummary, stackHasEnv, preview, lastDeployAt, containers] = await Promise.all([
      this.collect('backup info', stackName, () => fsSvc.getBackupInfo(stackName)),
      this.collect('backup env summary', stackName, () => fsSvc.getBackupEnvSummary(stackName)),
      this.collect('stack env presence', stackName, () => fsSvc.envExists(stackName)),
      this.collect('update preview', stackName, () =>
        withTimeout(UpdatePreviewService.getInstance().getPreview(nodeId, stackName), INPUT_TIMEOUT_MS, 'rollback readiness update preview')),
      this.collect('activity history', stackName, async () => {
        const events = db.getStackActivity(nodeId, stackName, { limit: 50 });
        return events.find(e => e.category === 'deploy_success')?.timestamp ?? null;
      }),
      this.collect('containers', stackName, () =>
        withTimeout(this.probeContainers(nodeId, stackName), INPUT_TIMEOUT_MS, 'rollback readiness container probe')),
    ]);

    const items = buildRollbackItems({
      backup,
      envSummary,
      stackHasEnv,
      rollbackTarget: preview === 'error' ? 'error' : { target: preview.rollback_target },
      lastDeployAt,
      containers,
    }, now);

    return { stack: stackName, computedAt: now, overall: aggregateRollbackOverall(items), items };
  }

  /** Host disk use percent for the main filesystem, or null when unavailable. */
  private async readDiskUsage(): Promise<number | null> {
    const fsSize = await withTimeout(si.fsSize(), INPUT_TIMEOUT_MS, 'readiness disk stats');
    const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];
    if (typeof mainDisk?.use !== 'number') {
      console.warn('[UpdateGuard] disk stats returned no usable mount; disk signal degrades to unknown');
      return null;
    }
    return mainDisk.use;
  }

  /** Run one input collector; a failure degrades to the 'error' sentinel. */
  private async collect<T>(label: string, stackName: string, fn: () => Promise<T>): Promise<T | Errored> {
    try {
      return await fn();
    } catch (error) {
      console.warn(
        `[UpdateGuard] ${label} unavailable for ${sanitizeForLog(stackName)}:`,
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return 'error';
    }
  }
}
