import { Router, type Request, type Response } from 'express';
import path from 'path';
import si from 'systeminformation';
import DockerController, { globalDockerNetwork } from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { CacheService } from '../services/CacheService';
import { NodeRegistry } from '../services/NodeRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';
import { PeerToCentralMeshSessionDialer } from '../services/PeerToCentralMeshSessionDialer';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { STATS_CACHE_TTL_MS, SYSTEM_STATS_CACHE_TTL_MS } from '../helpers/constants';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import {
  type GlobalLogEntry,
  normalizeContainerName,
  parseLogTimestamp,
  detectLogLevel,
  demuxDockerLog,
} from '../utils/log-parsing';

export const metricsRouter = Router();

/**
 * Container stats aggregated for the dashboard. Cached per-node for 2s to
 * collapse multi-tab polling pressure. Write-path endpoints (deploy, down,
 * start, stop, restart) invalidate this key via `invalidateNodeCaches`.
 */
metricsRouter.get('/stats', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(req.nodeId));
    const result = await CacheService.getInstance().getOrFetch(
      `stats:${req.nodeId}`,
      STATS_CACHE_TTL_MS,
      async () => {
        const allContainers = await DockerController.getInstance(req.nodeId).getAllContainers();

        // "Managed" means Docker started the container from within COMPOSE_DIR.
        // We key on `com.docker.compose.project.working_dir` rather than the
        // project name so stacks launched from the COMPOSE_DIR root (not a
        // subdirectory) aren't all mis-classified as external.
        const isManagedByComposeDir = (c: { Labels?: Record<string, string> }): boolean => {
          const workingDir: string | undefined = c.Labels?.['com.docker.compose.project.working_dir'];
          if (!workingDir) return false;
          const resolved = path.resolve(workingDir);
          return resolved === composeDir || resolved.startsWith(composeDir + path.sep);
        };

        type ContainerInfo = { State?: string; Labels?: Record<string, string> };
        const cs = allContainers as ContainerInfo[];
        const active = cs.filter(c => c.State === 'running').length;
        const exited = cs.filter(c => c.State === 'exited').length;
        const total = cs.length;
        const managed = cs.filter(c => c.State === 'running' && isManagedByComposeDir(c)).length;
        const unmanaged = cs.filter(c => c.State === 'running' && !isManagedByComposeDir(c)).length;

        return { active, managed, unmanaged, exited, total };
      },
    );
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

metricsRouter.get('/metrics/historical', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const metrics = DatabaseService.getInstance().getContainerMetrics(24);
    res.json(metrics);
  } catch {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

metricsRouter.get('/logs/global', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const debug = isDebugEnabled();
    const dockerController = DockerController.getInstance(req.nodeId);
    const containers = await dockerController.getRunningContainers();
    const allLogs: GlobalLogEntry[] = [];
    if (debug) console.debug('[GlobalLogs:debug] Polling snapshot starting', { containerCount: containers.length, nodeId: req.nodeId });

    await Promise.all(containers.map(async (c) => {
      const stackName = c.Labels?.['com.docker.compose.project'] || 'system';
      const rawName = c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
      const containerName = normalizeContainerName(rawName, stackName);

      try {
        const container = dockerController.getDocker().getContainer(c.Id);
        const inspect = await container.inspect();
        const isTty = inspect.Config.Tty;
        const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: 100, timestamps: true }) as Buffer;

        demuxDockerLog(logsBuffer, isTty, (line, source) => {
          if (!line.trim()) return;
          const { timestampMs, cleanMessage } = parseLogTimestamp(line);
          const level = detectLogLevel(cleanMessage, source);
          allLogs.push({ stackName, containerName, source, level, message: cleanMessage, timestampMs });
        });
      } catch (err) {
        console.warn(`[GlobalLogs] Failed to fetch/parse logs for container ${containerName} (${c.Id.substring(0, 12)}):`, getErrorMessage(err, 'unknown'));
      }
    }));

    // Sort ascending by timestamp (newest bottom). Limit to 500 lines; the
    // client only renders ~300 at a time.
    allLogs.sort((a, b) => a.timestampMs - b.timestampMs);
    if (debug) console.debug('[GlobalLogs:debug] Polling snapshot complete', { totalLines: allLogs.length });
    res.json(allLogs.slice(-500));
  } catch (error) {
    console.error('[GlobalLogs] Snapshot fetch failed:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to fetch global logs' });
  }
});

metricsRouter.get('/logs/global/stream', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Prevent nginx from buffering SSE events (would cause burst delivery).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const debug = isDebugEnabled();
  const dockerController = DockerController.getInstance(req.nodeId);
  const streams: NodeJS.ReadableStream[] = [];

  // SSE heartbeat (: prefix is a comment, silently dropped by EventSource)
  // every 30s keeps reverse proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(':heartbeat\n\n');
  }, 30_000);

  try {
    const containers = await dockerController.getRunningContainers();
    if (debug) console.debug('[GlobalLogs:debug] SSE stream opened', { containerCount: containers.length, nodeId: req.nodeId });

    await Promise.all(containers.map(async (c) => {
      const stackName = c.Labels?.['com.docker.compose.project'] || 'system';
      const rawName = c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
      const containerName = normalizeContainerName(rawName, stackName);

      try {
        const container = dockerController.getDocker().getContainer(c.Id);
        const inspect = await container.inspect();
        const isTty = inspect.Config.Tty;

        const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 500, timestamps: true });
        streams.push(stream);

        stream.on('data', (chunk: Buffer) => {
          demuxDockerLog(chunk, isTty, (line, source) => {
            if (!line.trim()) return;
            const { timestampMs, cleanMessage } = parseLogTimestamp(line);
            const level = detectLogLevel(cleanMessage, source);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ stackName, containerName, source, level, message: cleanMessage, timestampMs })}\n\n`);
            }
          });
        });
      } catch (err) {
        console.warn(`[GlobalLogs] Failed to attach stream for container ${containerName} (${c.Id.substring(0, 12)}):`, getErrorMessage(err, 'unknown'));
      }
    }));

    req.on('close', () => {
      clearInterval(heartbeat);
      if (debug) console.debug('[GlobalLogs:debug] SSE stream closed, cleaning up', { streamCount: streams.length });
      streams.forEach(s => {
        try { (s as NodeJS.ReadableStream & { destroy(): void }).destroy(); } catch { /* stream already ended */ }
      });
    });

  } catch (error) {
    clearInterval(heartbeat);
    console.error('[GlobalLogs] SSE stream attachment failed:', getErrorMessage(error, 'unknown'));
    res.write(`data: ${JSON.stringify({ level: 'ERROR', message: '[Sencho] Failed to attach global log stream.', timestampMs: Date.now(), stackName: 'system', containerName: 'backend', source: 'STDERR' })}\n\n`);
    res.end();
  }
});

/**
 * Host-level CPU / memory / disk / network sample. Cached for 3s to collapse
 * overlapping samplers (dashboard polls every 5s, MonitorService samples
 * every 30s, `si.currentLoad()` blocks ~200ms per call). No write-path
 * invalidation: these are pure host metrics.
 */
metricsRouter.get('/system/stats', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    // Network is read outside the cache because it is cheap and per-request.
    const rxSec = Math.max(0, globalDockerNetwork.rxSec);
    const txSec = Math.max(0, globalDockerNetwork.txSec);

    const sample = await CacheService.getInstance().getOrFetch(
      `system-stats:${req.nodeId}`,
      SYSTEM_STATS_CACHE_TTL_MS,
      async () => {
        // Remote-node requests are intercepted and proxied upstream before
        // reaching here; this fetcher only runs for local nodes.
        const [currentLoad, mem, fsSize] = await Promise.all([
          si.currentLoad(),
          si.mem(),
          si.fsSize(),
        ]);

        const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];

        return {
          cpu: {
            usage: currentLoad.currentLoad.toFixed(1),
            cores: currentLoad.cpus.length,
          },
          memory: {
            total: mem.total,
            used: mem.used,
            free: mem.free,
            usagePercent: ((mem.used / mem.total) * 100).toFixed(1),
          },
          disk: mainDisk ? {
            fs: mainDisk.fs,
            mount: mainDisk.mount,
            total: mainDisk.size,
            used: mainDisk.used,
            free: mainDisk.available,
            usagePercent: mainDisk.use ? mainDisk.use.toFixed(1) : '0',
          } : null,
        };
      },
    );

    res.json({ ...sample, network: { rxBytes: 0, txBytes: 0, rxSec, txSec } });
  } catch (error) {
    console.error('Failed to fetch system stats:', error);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
});

/**
 * Admin-only cache observability. Surfaces per-namespace hit/miss/stale
 * counters and live entry counts for the unified CacheService. Used by
 * Settings → About and for post-deploy verification that cache hit rates
 * look healthy.
 */
metricsRouter.get('/system/cache-stats', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(CacheService.getInstance().getStats());
  } catch (error) {
    console.error('Failed to fetch cache stats:', error);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

/**
 * Admin-only pilot tunnel observability. Counters reset on process restart
 * by design (see PilotMetrics.ts). The per_node array is the load-bearing
 * field: aggregate counters can hide a single tunnel that is flapping or
 * sitting on a stuck write buffer.
 */
metricsRouter.get('/system/pilot-tunnels', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const snapshot = PilotTunnelManager.getInstance().getMetricsSnapshot();
    // centralCallback exposes the peer-side view of the symmetric mesh
    // callback path (cached central material plus the live bridge presence).
    // PilotMetrics already tracks the attempt/success counters via
    // `counters.mesh_central_bootstraps_total` and friends; this block adds
    // the per-instance last-success / last-failure diagnostics that live in
    // MeshCentralRegistry rather than PilotMetrics.
    const cached = MeshCentralRegistry.getInstance().getActive();
    const centralCallback = {
      bridgeOpen: PeerToCentralMeshSessionDialer.getInstance().hasSession(),
      lastBootstrapAt: cached?.lastBootstrapAt ?? null,
      lastDialOkAt: cached?.lastUsedAt ?? null,
      lastDialFailAt: cached?.lastRejectedAt ?? null,
      lastDialFailReason: cached?.lastRejectReason ?? null,
    };
    res.json({ ...snapshot, centralCallback });
  } catch (error) {
    console.error('Failed to fetch pilot tunnel metrics:', error);
    res.status(500).json({ error: 'Failed to fetch pilot tunnel metrics' });
  }
});
