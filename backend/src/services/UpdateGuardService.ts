import si from 'systeminformation';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { ComposeDoctorService } from './ComposeDoctorService';
import { UpdatePreviewService, isMovingTag, filterPreviewForService, buildDetectionDisabledPreview } from './UpdatePreviewService';
import { ImageUpdateService } from './ImageUpdateService';
import { buildEffectiveServiceModel, type EffectiveServiceModelResult } from './effectiveServiceModel';
import { filterContainersByComposeService } from '../helpers/composeServiceMatch';
import { isDockerHealthcheckActive } from '../helpers/healthcheckPresence';
import { withTimeout } from '../utils/withTimeout';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import {
  aggregateRollbackOverall,
  aggregateVerdict,
  backupSlotSignal,
  buildRollbackItems,
  buildServicesSignal,
  containersSignal,
  diskSignal,
  driftSignal,
  healthchecksSignal,
  isTroubledContainer,
  preflightSignal,
  serviceSignal,
  updatePreviewSignal,
  type Errored,
  type ServiceMembership,
} from './updateGuard/readiness';
import type { ContainerProbe, RollbackReadinessReport, UpdateReadinessReport } from './updateGuard/types';

// Bound on the network-and-socket-backed inputs (container probe, update
// preview, disk stats) so a hung registry or Docker socket cannot stall the
// report past the dialog's own fetch timeout; the remaining inputs are local
// DB/file reads. A timed-out input degrades to its 'unknown' signal instead
// of failing the report.
const INPUT_TIMEOUT_MS = 3_000;

/**
 * Thrown by `computeUpdateReadiness` when a `serviceName` is given for a
 * stack that has one (or zero) declared services: service-scoped readiness
 * requires a real choice among siblings. The route maps this to a 400,
 * distinct from the 500 a genuine computation failure gets.
 */
export class SingleServiceUpdateReadinessError extends Error {
  constructor() {
    super('Service-scoped readiness requires a stack with more than one service.');
    this.name = 'SingleServiceUpdateReadinessError';
  }
}

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
   * the 'error' sentinel. When `serviceName` is given, narrows to that
   * service's containers before inspecting (labeled containers, per §6).
   */
  async probeContainers(nodeId: number, stackName: string, serviceName?: string): Promise<ContainerProbe[]> {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${stackName}`] },
    });
    const scoped = serviceName ? filterContainersByComposeService(listed, serviceName) : listed;
    const probes = await Promise.all(
      scoped.map(async (info): Promise<ContainerProbe | null> => {
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
          hasHealthcheck: isDockerHealthcheckActive(inspect.Config?.Healthcheck?.Test),
          restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || null,
          mounts,
        };
      }),
    );
    return probes.filter((p): p is ContainerProbe => p !== null);
  }

  /**
   * When `serviceName` is set, scopes the verdict-affecting inputs (labeled
   * containers, healthchecks, the update preview, and drift) to that service
   * only; the stack guardrails (preflight, disk, backup, Docker reachability)
   * stay unchanged (§6). A render failure or missing service fails closed via
   * the added `service` signal; a single-service stack throws instead of
   * scoping (the caller/route maps that to a 400).
   */
  async computeUpdateReadiness(nodeId: number, stackName: string, serviceName?: string): Promise<UpdateReadinessReport> {
    const db = DatabaseService.getInstance();
    const now = Date.now();

    let model: EffectiveServiceModelResult | null = null;
    if (serviceName) {
      model = await buildEffectiveServiceModel(nodeId, stackName);
      if (model.renderable && model.services.length <= 1) {
        throw new SingleServiceUpdateReadinessError();
      }
    }

    const [preflight, drift, containers, siblings, preview, backup, disk] = await Promise.all([
      this.collect('preflight', stackName, async () => ComposeDoctorService.getInstance().getLatest(nodeId, stackName)),
      this.collect('drift', stackName, async () =>
        db.getOpenDriftFindings(nodeId, stackName).filter(f => !serviceName || f.service === serviceName).length),
      this.collect('containers', stackName, () =>
        withTimeout(this.probeContainers(nodeId, stackName, serviceName), INPUT_TIMEOUT_MS, 'readiness container probe')),
      serviceName
        ? this.collect('sibling containers', stackName, () =>
            withTimeout(this.probeContainers(nodeId, stackName), INPUT_TIMEOUT_MS, 'readiness sibling probe'))
        : Promise.resolve<ContainerProbe[] | Errored>([]),
      this.collect('update preview', stackName, async () => {
        // Check inside the thunk so the read stays with the getPreview call.
        // Stack GET/POST update-preview use the same isChecksEnabled gate.
        if (!ImageUpdateService.isChecksEnabled()) {
          const disabled = buildDetectionDisabledPreview(stackName);
          return serviceName ? filterPreviewForService(disabled, serviceName) : disabled;
        }
        const full = await withTimeout(UpdatePreviewService.getInstance().getPreview(nodeId, stackName), INPUT_TIMEOUT_MS, 'readiness update preview');
        return serviceName ? filterPreviewForService(full, serviceName) : full;
      }),
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
      updatePreviewSignal(preview === 'error' ? 'error' : preview.summary, preview === 'error' ? undefined : preview.images),
      buildServicesSignal(preview === 'error' ? 'error' : preview.build_services),
      backupSlotSignal(backup, now),
      diskSignal(typeof disk === 'number' ? { usePercent: disk, limitPercent } : 'error'),
    ];
    if (serviceName) {
      signals.push(serviceSignal(this.resolveServiceMembership(model, serviceName)));
    }

    const advisories = serviceName
      ? [
          this.siblingHealthAdvisory(containers, siblings),
          this.dependencyAdvisory(model, serviceName),
        ].filter((note): note is string => note !== null)
      : [];

    return {
      stack: stackName,
      computedAt: now,
      verdict: aggregateVerdict(signals),
      signals,
      serviceName: serviceName ?? null,
      advisories,
    };
  }

  /** Model-membership facts for the selected service; 'error' when the model failed to render. */
  private resolveServiceMembership(model: EffectiveServiceModelResult | null, serviceName: string): ServiceMembership | Errored {
    if (!model || !model.renderable) return 'error';
    const spec = model.services.find(s => s.name === serviceName);
    if (!spec) return { found: false };
    return { found: true, hasBuild: spec.hasBuild, declaredImage: spec.declaredImage, expectedReplicas: spec.expectedReplicas };
  }

  /** Advisory only (§6): a sibling already unhealthy before the update never blocks the selected service's verdict. */
  private siblingHealthAdvisory(selected: ContainerProbe[] | Errored, all: ContainerProbe[] | Errored): string | null {
    if (selected === 'error' || all === 'error') return null;
    const selectedNames = new Set(selected.map(c => c.name));
    const troubled = all.filter(c => !selectedNames.has(c.name) && isTroubledContainer(c));
    if (troubled.length === 0) return null;
    const names = troubled.map(c => c.name).join(', ');
    return `Other containers in this stack are already unhealthy: ${names}. This does not block the selected service.`;
  }

  /** Advisory only (§6): dependsOn relationships are informational; this update never recreates siblings. */
  private dependencyAdvisory(model: EffectiveServiceModelResult | null, serviceName: string): string | null {
    if (!model || !model.renderable) return null;
    const spec = model.services.find(s => s.name === serviceName);
    const dependsOn = spec?.dependsOn ?? [];
    const dependents = model.services.filter(s => s.dependsOn.includes(serviceName)).map(s => s.name);
    const parts: string[] = [];
    if (dependsOn.length > 0) parts.push(`depends on ${dependsOn.join(', ')}`);
    if (dependents.length > 0) parts.push(`is a dependency of ${dependents.join(', ')}`);
    if (parts.length === 0) return null;
    return `This service ${parts.join(' and ')}. Those services are not restarted by this update.`;
  }

  async computeRollbackReadiness(nodeId: number, stackName: string): Promise<RollbackReadinessReport> {
    const db = DatabaseService.getInstance();
    const fsSvc = FileSystemService.getInstance(nodeId);
    const now = Date.now();

    const [backup, envSummary, stackHasEnv, preview, lastDeployAt, containers] = await Promise.all([
      this.collect('backup info', stackName, () => fsSvc.getBackupInfo(stackName)),
      this.collect('backup env summary', stackName, () => fsSvc.getBackupEnvSummary(stackName)),
      this.collect('stack env presence', stackName, () => fsSvc.envExists(stackName)),
      this.collect('update preview', stackName, async () => {
        if (!ImageUpdateService.isChecksEnabled()) {
          return buildDetectionDisabledPreview(stackName);
        }
        return withTimeout(UpdatePreviewService.getInstance().getPreview(nodeId, stackName), INPUT_TIMEOUT_MS, 'rollback readiness update preview');
      }),
      this.collect('activity history', stackName, async () => {
        const events = db.getStackActivity(nodeId, stackName, { limit: 50 });
        // A successful update is as good a known-good marker as a deploy.
        return events.find(e => e.category === 'deploy_success' || e.category === 'image_update_applied')?.timestamp ?? null;
      }),
      this.collect('containers', stackName, () =>
        withTimeout(this.probeContainers(nodeId, stackName), INPUT_TIMEOUT_MS, 'rollback readiness container probe')),
    ]);

    const items = buildRollbackItems({
      backup,
      envSummary,
      stackHasEnv,
      rollbackTarget: preview === 'error'
        ? 'error'
        : {
            target: preview.rollback_target,
            // Any image on a moving tag means restoring files cannot guarantee
            // the image reverts, so the rollback target is not a true revert.
            moving: preview.images.some(img => isMovingTag(img.current_tag)),
          },
      lastDeployAt,
      containers,
    }, now);

    // Partial-revert disclosure for Git-managed stacks: rollback restores only
    // compose files and .env; the rest of the materialized project is not
    // reverted by the backup slot. State the scope rather than imply a
    // complete revert.
    let note: string | undefined;
    const gitSource = db.getGitSource(stackName);
    if (gitSource && (gitSource.manifest_state === 'active' || gitSource.manifest_state === 'partial' || gitSource.manifest_state === 'migrated')) {
      note = 'This stack is Git-managed. Rollback restores compose files and .env; other materialized inputs are not reverted. Re-apply the previous revision from Git to restore them.';
    }

    return { stack: stackName, computedAt: now, overall: aggregateRollbackOverall(items), items, note };
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
        '[UpdateGuard] %s unavailable for %s:',
        label, sanitizeForLog(stackName),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
      return 'error';
    }
  }
}
