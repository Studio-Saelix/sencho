import type { Server } from 'http';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { LicenseService } from '../services/LicenseService';
import SelfUpdateService from '../services/SelfUpdateService';
import { MonitorService } from '../services/MonitorService';
import { AutoHealService } from '../services/AutoHealService';
import { FleetSyncRetryService } from '../services/FleetSyncRetryService';
import { DockerEventManager } from '../services/DockerEventManager';
import TrivyService, { sweepStaleTrivyTempDirs } from '../services/TrivyService';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { SchedulerService } from '../services/SchedulerService';
import { MfaService } from '../services/MfaService';
import { MeshService } from '../services/MeshService';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { sweepStaleTempDirs as sweepStaleGitTempDirs } from '../services/GitSourceService';
import { PORT } from '../helpers/constants';

/**
 * Run the startup sequence: stack-directory migration, service initialization,
 * background watchdogs, then bind the HTTP server. The caller passes the
 * already-constructed server so tests can import the module without binding a
 * port.
 */
export async function startServer(server: Server): Promise<void> {
  try {
    console.log('Running stack migration check...');
    const defaultFsService = FileSystemService.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
    await defaultFsService.migrateFlatToDirectory();
    console.log('Migration check completed');
  } catch (error) {
    console.error('Migration failed:', error);
  }

  // Initialize the license service before any tier-gated code can run.
  LicenseService.getInstance().initialize();

  // Synchronous starts: schedule background timers and continue. None of
  // these fire their first tick for at least a few seconds, so they
  // safely run alongside the async initializers below.
  MonitorService.getInstance().start();
  AutoHealService.getInstance().start();
  FleetSyncRetryService.getInstance().start();
  ImageUpdateService.getInstance().start();
  SchedulerService.getInstance().start();
  MfaService.getInstance().start();
  MeshService.getInstance().start().catch((err) => {
    console.warn('[Startup] MeshService start failed:', (err as Error).message);
  });
  BlueprintReconciler.getInstance().start();

  // Async initializers are independent of each other; run in parallel
  // so total boot time is the slowest one rather than the sum.
  await Promise.all([
    SelfUpdateService.getInstance().initialize(),
    DockerEventManager.getInstance().start(),
    TrivyService.getInstance().initialize(),
  ]);

  // Fire-and-forget housekeeping; logged but never awaited.
  sweepStaleGitTempDirs().catch((err) => {
    console.warn('[GitSource] Temp dir sweep failed:', (err as Error).message);
  });
  sweepStaleTrivyTempDirs().catch((err) => {
    console.warn('[Trivy] Temp dir sweep failed:', (err as Error).message);
  });

  const isPilotAgent = process.env.SENCHO_MODE === 'pilot';
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
