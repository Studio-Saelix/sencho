import type { Server } from 'http';
import { DatabaseService } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';
import { MonitorService } from '../services/MonitorService';
import { AutoHealService } from '../services/AutoHealService';
import { HealthGateService } from '../services/HealthGateService';
import { FleetSyncRetryService } from '../services/FleetSyncRetryService';
import { DockerEventManager } from '../services/DockerEventManager';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { SchedulerService } from '../services/SchedulerService';
import { MfaService } from '../services/MfaService';
import { MeshService } from '../services/MeshService';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { PilotMetrics } from '../services/PilotMetrics';

/**
 * Wire graceful shutdown handlers. Docker sends SIGTERM when the container
 * stops; Ctrl-C sends SIGINT in dev. We allow in-flight requests to finish,
 * then cleanly stop background services and close the SQLite connection
 * before exiting. A 10 s force-exit timer guards against hung connections.
 */
export function installShutdownHandlers(server: Server): void {
  const gracefulShutdown = (signal: string): void => {
    console.log(`[Shutdown] ${signal} received - shutting down gracefully…`);

    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
      try { LicenseService.getInstance().destroy(); } catch (e) {
        console.warn('[Shutdown] LicenseService cleanup failed:', (e as Error).message);
      }
      try { MonitorService.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] MonitorService cleanup failed:', (e as Error).message);
      }
      try { AutoHealService.getInstance().stop(); } catch (e) { console.warn('[Shutdown] AutoHealService cleanup failed:', (e as Error).message); }
      try { HealthGateService.getInstance().stop(); } catch (e) { console.warn('[Shutdown] HealthGateService cleanup failed:', (e as Error).message); }
      try { FleetSyncRetryService.getInstance().stop(); } catch (e) { console.warn('[Shutdown] FleetSyncRetryService cleanup failed:', (e as Error).message); }
      try { DockerEventManager.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] DockerEventManager cleanup failed:', (e as Error).message);
      }
      try { ImageUpdateService.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] ImageUpdateService cleanup failed:', (e as Error).message);
      }
      try { SchedulerService.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] SchedulerService cleanup failed:', (e as Error).message);
      }
      try { MfaService.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] MfaService cleanup failed:', (e as Error).message);
      }
      MeshService.getInstance().stop().catch((e) => {
        console.warn('[Shutdown] MeshService cleanup failed:', (e as Error).message);
      });
      try { BlueprintReconciler.getInstance().stop(); } catch (e) {
        console.warn('[Shutdown] BlueprintReconciler cleanup failed:', (e as Error).message);
      }
      try { PilotMetrics.flush(); } catch (e) {
        console.warn('[Shutdown] PilotMetrics flush failed:', (e as Error).message);
      }
      try { DatabaseService.getInstance().flushAuditLogBuffer(); } catch (e) {
        console.warn('[Shutdown] Audit log flush failed:', (e as Error).message);
      }
      try { DatabaseService.getInstance().getDb().close(); } catch (e) {
        console.warn('[Shutdown] Database close failed:', (e as Error).message);
      }
      console.log('[Shutdown] Done - exiting');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[Shutdown] Timed out waiting for connections - forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
