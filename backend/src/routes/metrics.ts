import { Router, type Request, type Response } from 'express';
import path from 'path';
import si from 'systeminformation';
import DockerController, { globalDockerNetwork } from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { CacheService } from '../services/CacheService';
import { NodeRegistry } from '../services/NodeRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { STATS_CACHE_TTL_MS, SYSTEM_STATS_CACHE_TTL_MS } from '../helpers/constants';
import { getHostMemory } from '../helpers/hostMemory';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { isManagedByComposeDir } from '../utils/managed-containers';
import { GlobalLogsMetrics } from '../services/GlobalLogsMetrics';
import {
  type GlobalLogEntry,
  normalizeContainerName,
  parseLogTimestamp,
  detectLogLevel,
  demuxDockerLog,
  createFrameDemuxer,
} from '../utils/log-parsing';

export const metricsRouter = Router();

// Lines of history each container replays when a feed opens. Bounds the
// open-time burst (was 500 per container, multiplied across every container).
const STREAM_INITIAL_TAIL = 200;
const POLL_TAIL = 100;
// Hard cap on simultaneous `docker logs --follow` streams behind one SSE
// connection. Beyond this the feed is truncated and the operator is told.
const MAX_FOLLOW_STREAMS = 60;
// Concurrency limit for the polling snapshot's per-container Docker calls so a
// large managed set does not fan out N simultaneous requests at the daemon.
const POLL_CONCURRENCY = 8;

interface ContainerSummary {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

/** Read a managed-only set of running containers for the node. */
async function getManagedRunningContainers(
  nodeId: number,
): Promise<{ containers: ContainerSummary[]; total: number }> {
  const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
  const all = (await DockerController.getInstance(nodeId).getRunningContainers()) as ContainerSummary[];
  const containers = all.filter(c => isManagedByComposeDir(c, composeDir));
  return { containers, total: all.length };
}

/** Map a Docker container summary to its display stack + container name. */
function describeContainer(c: ContainerSummary): { stackName: string; containerName: string } {
  const stackName = c.Labels?.['com.docker.compose.project'] || 'system';
  const rawName = c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
  return { stackName, containerName: normalizeContainerName(rawName, stackName) };
}

/**
 * Run an async mapper over items with a bounded number in flight. The caller's
 * `fn` must handle its own errors: a rejection propagates and abandons the
 * remaining work (the log endpoints wrap their body in try/catch for this).
 * Exported for unit testing.
 */
export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  };
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

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

        type ContainerInfo = { State?: string; Labels?: Record<string, string> };
        const cs = allContainers as ContainerInfo[];
        const active = cs.filter(c => c.State === 'running').length;
        const exited = cs.filter(c => c.State === 'exited').length;
        const total = cs.length;
        const managed = cs.filter(c => c.State === 'running' && isManagedByComposeDir(c, composeDir)).length;
        const unmanaged = cs.filter(c => c.State === 'running' && !isManagedByComposeDir(c, composeDir)).length;

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
  if (!requireAdmin(req, res)) return;
  try {
    GlobalLogsMetrics.increment('poll_requests_total');
    const debug = isDebugEnabled();
    const dockerController = DockerController.getInstance(req.nodeId);
    const { containers, total } = await getManagedRunningContainers(req.nodeId);
    const allLogs: GlobalLogEntry[] = [];
    if (debug) console.debug('[GlobalLogs:debug] Polling snapshot starting', { managed: containers.length, total, nodeId: req.nodeId });

    await mapWithConcurrency(containers, POLL_CONCURRENCY, async (c) => {
      const { stackName, containerName } = describeContainer(c);
      try {
        const container = dockerController.getDocker().getContainer(c.Id);
        const inspect = await container.inspect();
        const isTty = inspect.Config.Tty;
        const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: POLL_TAIL, timestamps: true }) as Buffer;

        demuxDockerLog(logsBuffer, isTty, (line, source) => {
          if (!line.trim()) return;
          const { timestampMs, cleanMessage } = parseLogTimestamp(line);
          const level = detectLogLevel(cleanMessage, source);
          allLogs.push({ stackName, containerName, source, level, message: cleanMessage, timestampMs });
        });
      } catch (err) {
        // Mirror the SSE path so per-container read failures are visible on the
        // same counter rather than only in the log.
        GlobalLogsMetrics.increment('stream_attach_errors_total');
        console.warn(`[GlobalLogs] Failed to fetch/parse logs for container ${containerName} (${c.Id.substring(0, 12)}):`, getErrorMessage(err, 'unknown'));
      }
    });

    // Sort ascending by timestamp (newest bottom). Limit to 500 lines; the
    // client only renders ~300 at a time.
    allLogs.sort((a, b) => a.timestampMs - b.timestampMs);
    const snapshot = allLogs.slice(-500);
    GlobalLogsMetrics.increment('lines_streamed_total', snapshot.length);
    if (debug) console.debug('[GlobalLogs:debug] Polling snapshot complete', { totalLines: allLogs.length, returned: snapshot.length });
    res.json(snapshot);
  } catch (error) {
    console.error('[GlobalLogs] Snapshot fetch failed:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to fetch global logs' });
  }
});

metricsRouter.get('/logs/global/stream', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Prevent nginx from buffering SSE events (would cause burst delivery).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const debug = isDebugEnabled();
  const dockerController = DockerController.getInstance(req.nodeId);
  const streams: NodeJS.ReadableStream[] = [];

  GlobalLogsMetrics.openConnection();
  let closed = false;
  let paused = false;

  const destroyStream = (s: NodeJS.ReadableStream): void => {
    try { (s as NodeJS.ReadableStream & { destroy(): void }).destroy(); } catch { /* already ended */ }
  };
  // Back off every source follow-stream when the socket buffer fills, then
  // resume on 'drain', so a slow client cannot drive unbounded Node-side
  // buffering across N concurrent streams.
  const pauseAll = (): void => { if (paused) return; paused = true; streams.forEach(s => { try { s.pause(); } catch { /* ended */ } }); };
  const resumeAll = (): void => { if (!paused) return; paused = false; streams.forEach(s => { try { s.resume(); } catch { /* ended */ } }); };
  res.on('drain', resumeAll);

  const writeEvent = (entry: GlobalLogEntry): void => {
    if (res.writableEnded) return;
    const ok = res.write(`data: ${JSON.stringify(entry)}\n\n`);
    GlobalLogsMetrics.increment('lines_streamed_total');
    if (!ok) pauseAll();
  };

  // SSE heartbeat (: prefix is a comment, silently dropped by EventSource)
  // every 30s keeps reverse proxies from closing idle connections. Honor
  // backpressure here too so a heartbeat that fills the socket buffer still
  // pauses the source streams.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.write(':heartbeat\n\n')) pauseAll();
  }, 30_000);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.removeListener('drain', resumeAll);
    if (debug) console.debug('[GlobalLogs:debug] SSE stream closed, cleaning up', { streamCount: streams.length });
    streams.forEach(destroyStream);
    GlobalLogsMetrics.closeConnection();
  };
  req.on('close', cleanup);

  try {
    const { containers, total } = await getManagedRunningContainers(req.nodeId);
    const followSet = containers.slice(0, MAX_FOLLOW_STREAMS);
    const truncated = containers.length - followSet.length;
    if (debug) console.debug('[GlobalLogs:debug] SSE stream opened', { managed: containers.length, total, following: followSet.length, nodeId: req.nodeId });

    await Promise.all(followSet.map(async (c) => {
      const { stackName, containerName } = describeContainer(c);
      try {
        const container = dockerController.getDocker().getContainer(c.Id);
        const inspect = await container.inspect();
        const isTty = inspect.Config.Tty;

        const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: STREAM_INITIAL_TAIL, timestamps: true });
        // The connection may have closed while we awaited inspect/logs.
        if (closed) { destroyStream(stream); return; }
        streams.push(stream);
        if (paused) { try { stream.pause(); } catch { /* ended */ } }

        const demuxer = createFrameDemuxer(
          isTty,
          (line, source) => {
            if (!line.trim()) return;
            const { timestampMs, cleanMessage } = parseLogTimestamp(line);
            const level = detectLogLevel(cleanMessage, source);
            writeEvent({ stackName, containerName, source, level, message: cleanMessage, timestampMs });
          },
          () => GlobalLogsMetrics.increment('demux_frame_errors_total'),
        );

        stream.on('data', (chunk: Buffer) => demuxer.push(chunk));
        // Drain the demuxer's buffered trailing line (one with no newline, the
        // common shape of a crash/exit line) when the follow stream ends or
        // breaks, so the last thing a container said is not silently lost.
        stream.on('end', () => demuxer.flush());
        stream.on('error', (err) => {
          GlobalLogsMetrics.increment('stream_attach_errors_total');
          console.warn(`[GlobalLogs] Follow stream error for ${containerName} (${c.Id.substring(0, 12)}):`, getErrorMessage(err, 'unknown'));
          demuxer.flush();
          // One degraded notice per drop (not per failed read) so the operator
          // sees the gap in the feed and the WARNINGS tile without log spam.
          writeEvent({ stackName, containerName, source: 'STDERR', level: 'WARN', message: `[Sencho] Log stream for ${containerName} ended unexpectedly; reopen the tab to resume.`, timestampMs: Date.now() });
          destroyStream(stream);
        });
      } catch (err) {
        GlobalLogsMetrics.increment('stream_attach_errors_total');
        console.warn(`[GlobalLogs] Failed to attach stream for container ${containerName} (${c.Id.substring(0, 12)}):`, getErrorMessage(err, 'unknown'));
      }
    }));

    if (truncated > 0) {
      writeEvent({ stackName: 'system', containerName: 'sencho', source: 'STDOUT', level: 'WARN', message: `[Sencho] Following ${followSet.length} of ${containers.length} managed containers; ${truncated} not shown. Use the per-container log viewer for the rest.`, timestampMs: Date.now() });
    }
  } catch (error) {
    console.error('[GlobalLogs] SSE stream attachment failed:', getErrorMessage(error, 'unknown'));
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ level: 'ERROR', message: '[Sencho] Failed to attach global log stream.', timestampMs: Date.now(), stackName: 'system', containerName: 'backend', source: 'STDERR' })}\n\n`);
    }
    cleanup();
    if (!res.writableEnded) res.end();
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
        const [currentLoad, hostMem, fsSize] = await Promise.all([
          si.currentLoad(),
          getHostMemory(),
          si.fsSize(),
        ]);

        const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];

        return {
          cpu: {
            usage: currentLoad.currentLoad.toFixed(1),
            cores: currentLoad.cpus.length,
          },
          memory: {
            total: hostMem.total,
            // ZFS ARC aware: reclaimable ARC is added back into available so a
            // large ARC cache is not reported as hard-used. See helpers/hostMemory.ts.
            used: hostMem.used,
            free: hostMem.free,
            usagePercent: hostMem.usagePercent.toFixed(1),
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
    res.json(snapshot);
  } catch (error) {
    console.error('Failed to fetch pilot tunnel metrics:', error);
    res.status(500).json({ error: 'Failed to fetch pilot tunnel metrics' });
  }
});

/**
 * Admin-only Global Observability log-stream observability. Process-local,
 * in-memory counters (reset on restart by design; see GlobalLogsMetrics). The
 * `active_sse_connections` gauge is the load-bearing field: it should drain to
 * zero when no Logs tab is open, and a rising `stream_attach_errors_total` or
 * `demux_frame_errors_total` points at a daemon or stream-corruption problem.
 */
metricsRouter.get('/system/log-stream-metrics', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(GlobalLogsMetrics.snapshot());
  } catch (error) {
    console.error('Failed to fetch log-stream metrics:', error);
    res.status(500).json({ error: 'Failed to fetch log-stream metrics' });
  }
});
