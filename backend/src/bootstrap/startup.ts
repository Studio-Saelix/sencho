import type { Server } from 'http';
import crypto from 'crypto';
import os from 'os';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';
import SelfUpdateService from '../services/SelfUpdateService';
import SelfIdentityService from '../services/SelfIdentityService';
import { MonitorService } from '../services/MonitorService';
import { AutoHealService } from '../services/AutoHealService';
import { HealthGateService } from '../services/HealthGateService';
import { FleetSyncRetryService } from '../services/FleetSyncRetryService';
import { DockerEventManager } from '../services/DockerEventManager';
import TrivyService, { sweepStaleTrivyTempDirs } from '../services/TrivyService';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { SchedulerService } from '../services/SchedulerService';
import { MfaService } from '../services/MfaService';
import { MeshService } from '../services/MeshService';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { applyPilotModeCapabilityFilter } from '../services/CapabilityRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { PilotMetrics } from '../services/PilotMetrics';
import { invalidateRemoteMetaCache } from '../helpers/cacheInvalidation';
import { sweepStaleTempDirs as sweepStaleGitTempDirs } from '../services/GitSourceService';
import { PORT } from '../helpers/constants';
import { LOW_MEMORY_FLOOR_BYTES } from '../utils/spawnErrors';

function isPilotMode(): boolean {
  return process.env.SENCHO_MODE === 'pilot';
}

/**
 * Pilot-agent hosts never run the first-run setup wizard, so the wizard
 * path that normally generates `auth_jwt_secret` (routes/auth.ts) never
 * fires. Without that secret, the agent-side loopback auth helper
 * (`pilot/agent.ts::getLoopbackAuthHeader`) cannot mint the
 * `pilot_tunnel`-scoped JWT it injects on every forwarded HTTP/WS request,
 * and the local Sencho's `authMiddleware` rejects every proxied call with
 * 401 "Authentication required". Generate the secret here on first boot in
 * pilot mode; subsequent boots reuse the persisted value. No-op outside
 * pilot mode (the wizard owns the lifecycle there).
 *
 * Returns true when a fresh secret was written, false otherwise.
 */
export function ensurePilotJwtSecret(): boolean {
  if (!isPilotMode()) return false;
  const dbSvc = DatabaseService.getInstance();
  if (dbSvc.getGlobalSettings().auth_jwt_secret) return false;
  const generated = crypto.randomBytes(64).toString('hex');
  dbSvc.updateGlobalSetting('auth_jwt_secret', generated);
  console.log('[Startup] pilot-agent: generated local auth_jwt_secret');
  return true;
}

function clearSelfContainerNotificationRouting(): void {
  const identity = SelfIdentityService.getInstance().getIdentity();
  const changed = DatabaseService.getInstance().clearSelfContainerNotificationRouting(
    NodeRegistry.getInstance().getDefaultNodeId(),
    {
      containerName: identity.containerName,
      composeProjectName: identity.composeProjectName,
    },
  );
  if (changed > 0) {
    console.log(`[Startup] Cleared stack routing from ${changed} Sencho self-container notification(s)`);
  }
}

/**
 * Run the startup sequence: stack-directory migration, service initialization,
 * background watchdogs, then bind the HTTP server. The caller passes the
 * already-constructed server so tests can import the module without binding a
 * port.
 */
export async function startServer(server: Server): Promise<void> {
  const freeBytes = os.freemem();
  const freeMiB = Math.round(freeBytes / (1024 * 1024));
  const totalMiB = Math.round(os.totalmem() / (1024 * 1024));
  const floorMiB = Math.round(LOW_MEMORY_FLOOR_BYTES / (1024 * 1024));
  console.log(`[Startup] Host memory: ${freeMiB} MiB free of ${totalMiB} MiB`);
  if (freeBytes < LOW_MEMORY_FLOOR_BYTES) {
    console.warn(
      `[Startup] Free host memory is ${freeMiB} MiB (below ${floorMiB} MiB floor). ` +
      'Sencho operations that spawn child processes (docker, /bin/sh) may fail ' +
      'with misleading ENOENT errors under memory pressure.'
    );
  }

  try {
    console.log('Running stack migration check...');
    const defaultFsService = FileSystemService.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
    await defaultFsService.migrateFlatToDirectory();
    console.log('Migration check completed');
  } catch (error) {
    console.error('Migration failed:', error);
  }

  ensurePilotJwtSecret();

  if (isPilotMode()) {
    applyPilotModeCapabilityFilter();
  }

  // Hydrate pilot/mesh counters from the persisted snapshot before any
  // service that increments them (MeshService, PilotTunnelManager) starts.
  // Failures fall through to zero-initialized counters; do not block boot.
  try {
    PilotMetrics.load(DatabaseService.getInstance());
  } catch (err) {
    console.warn('[Startup] PilotMetrics load failed:', (err as Error).message);
  }

  // Initialize the license service before any tier-gated code can run.
  LicenseService.getInstance().initialize();

  // Synchronous starts: schedule background timers and continue. None of
  // these fire their first tick for at least a few seconds, so they
  // safely run alongside the async initializers below.
  MonitorService.getInstance().start();
  AutoHealService.getInstance().start();
  HealthGateService.getInstance().start();
  FleetSyncRetryService.getInstance().start();
  ImageUpdateService.getInstance().start();
  SchedulerService.getInstance().start();
  MfaService.getInstance().start();
  MeshService.getInstance().start().catch((err) => {
    console.warn('[Startup] MeshService start failed:', (err as Error).message);
  });
  BlueprintReconciler.getInstance().start();

  // Drop the cached /api/meta entry on tunnel reconnect so the next
  // /api/nodes/:id/meta refetches fresh capabilities and version through
  // the live loopback bridge instead of waiting for the 3-minute TTL.
  PilotTunnelManager.getInstance().on('tunnel-up', invalidateRemoteMetaCache);

  // Most async initializers still run in parallel. Docker event monitoring
  // is sequenced after self identity so it never classifies Sencho's own
  // container as a routeable stack event.
  await Promise.all([
    SelfUpdateService.getInstance().initialize(),
    (async () => {
      await SelfIdentityService.getInstance().initialize();
      clearSelfContainerNotificationRouting();
      await DockerEventManager.getInstance().start();
    })(),
    TrivyService.getInstance().initialize(),
  ]);

  // Fire-and-forget housekeeping; logged but never awaited.
  sweepStaleGitTempDirs().catch((err) => {
    console.warn('[GitSource] Temp dir sweep failed:', (err as Error).message);
  });
  sweepStaleTrivyTempDirs().catch((err) => {
    console.warn('[Trivy] Temp dir sweep failed:', (err as Error).message);
  });

  const isPilotAgent = isPilotMode();
  const listenHost = isPilotAgent ? '127.0.0.1' : undefined;

  server.listen(PORT, listenHost, () => {
    console.log(`Server running on ${listenHost || '0.0.0.0'}:${PORT}${isPilotAgent ? ' (pilot-agent mode)' : ''}`);
    if (isPilotAgent) {
      import('../pilot/agent').then((m) => m.startPilotAgent(PORT)).catch((err) => {
        console.error('[Pilot] Agent startup failed:', err);
      });
    }
  });
}
