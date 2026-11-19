import { useEffect, useRef, useState } from 'react';
import type { ContainerInfo, ContainerStatsEntry } from '../EditorView';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

interface StatsSample {
  cpuPercent: number;
  memBytes: number;
  rx: number;
  tx: number;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// A counter Docker may leave out: absent reads as 0, anything else must be a finite number.
const optionalCounter = (v: unknown): number | null =>
  v == null ? 0 : isFiniteNumber(v) ? v : null;

/**
 * Turns one Docker stats frame into usable readings, or null when the frame
 * cannot yield them (a required counter missing, not a number, or not finite). The caller
 * drops such a frame: it must neither publish a metric nor count as proof that
 * the stream recovered. Counters Docker omits on some runtimes (system CPU time,
 * online CPUs, per-interface byte counts) stay optional. A null network entry
 * throws, which the caller reports as a parse failure.
 */
function readStatsSample(data: {
  cpu_stats?: { cpu_usage?: { total_usage?: unknown }; system_cpu_usage?: unknown; online_cpus?: unknown };
  precpu_stats?: { cpu_usage?: { total_usage?: unknown }; system_cpu_usage?: unknown };
  memory_stats?: { usage?: unknown };
  networks?: Record<string, { rx_bytes?: unknown; tx_bytes?: unknown }>;
}): StatsSample | null {
  if (!data.cpu_stats?.cpu_usage || !data.precpu_stats?.cpu_usage || !data.memory_stats?.usage) return null;

  const cpuTotal = data.cpu_stats.cpu_usage.total_usage;
  const preCpuTotal = data.precpu_stats.cpu_usage.total_usage;
  const memUsage = data.memory_stats.usage;
  if (!isFiniteNumber(cpuTotal) || !isFiniteNumber(preCpuTotal) || !isFiniteNumber(memUsage)) return null;

  const systemNow = optionalCounter(data.cpu_stats.system_cpu_usage);
  const systemPrev = optionalCounter(data.precpu_stats.system_cpu_usage);
  const onlineCpus = optionalCounter(data.cpu_stats.online_cpus);
  if (systemNow === null || systemPrev === null || onlineCpus === null) return null;

  let rx = 0;
  let tx = 0;
  if (data.networks) {
    for (const net of Object.values(data.networks)) {
      const rxBytes = optionalCounter(net.rx_bytes);
      const txBytes = optionalCounter(net.tx_bytes);
      if (rxBytes === null || txBytes === null) return null;
      rx += rxBytes;
      tx += txBytes;
    }
  }

  const systemDelta = systemNow - systemPrev;
  const cpuPercent = systemDelta > 0
    ? ((cpuTotal - preCpuTotal) / systemDelta) * (onlineCpus || 1) * 100
    : 0;
  const sample = { cpuPercent, memBytes: memUsage, rx, tx };
  return Object.values(sample).every(Number.isFinite) ? sample : null;
}

export interface ContainerStatsHookResult {
  stats: Record<string, ContainerStatsEntry>;
  error: string | null;
}

const STATS_UNAVAILABLE_MESSAGE = 'Container stats unavailable. The node may be unreachable.';
const NO_FAILURES: ReadonlySet<string> = new Set();

export function useContainerStats(
  containers: ContainerInfo[],
  activeNodeId: number | null | undefined,
): ContainerStatsHookResult {
  const [containerStats, setContainerStats] = useState<Record<string, ContainerStatsEntry>>({});
  // IDs of running containers whose current stats stream has failed. A container
  // leaves the set when it delivers a valid sample, when it stops or drops out of
  // the list, or when the active node changes.
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(NO_FAILURES);

  const pendingStatsRef = useRef<Record<string, {
    cpu: string; ram: string; net: string;
    lastRx: number; lastTx: number;
    cpuNum: number; memNum: number; netInNum: number; netOutNum: number;
  }>>({});

  const rawBytesRef = useRef<Record<string, { lastRx: number; lastTx: number }>>({});

  // Clear every stream failure only on an actual node switch. The main effect
  // drops only the containers that left the list or stopped running: clearing everything on each
  // containers-array identity change (the dashboard's refresh cadence) would
  // make the warning visibly flap against a persistently-flaky daemon.
  useEffect(() => {
    setFailedIds(NO_FAILURES);
  }, [activeNodeId]);

  useEffect(() => {
    const wsMap: Record<string, WebSocket> = {};
    // Set by the cleanup before it closes the sockets, as a second line of
    // defence next to the detached handlers: the browser fires error/close for a
    // socket closed while connecting, and that is our own teardown, not a
    // stream failure.
    let disposed = false;
    // Track which WSs have already emitted a console.warn for the lifetime of
    // this effect, so a flaky daemon does not spam the console at message rate.
    const warnedOnce = new Set<string>();

    const nodeQuery = activeNodeId != null ? `?nodeId=${activeNodeId}` : '';

    // Opening another stack starts clean, and a container that stopped starts
    // its next run clean too: a failure belongs to one running session. Running
    // containers that stay in the list keep their flag until they stream again,
    // so a refresh does not clear and re-raise the warning against a flaky daemon.
    const runningIds = new Set((containers || []).flatMap(c => (c?.Id && c.State === 'running' ? [c.Id] : [])));
    setFailedIds(prev => {
      const kept = [...prev].filter(id => runningIds.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });

    (containers || []).forEach(container => {
      if (!container?.Id) return;

      const recordFailure = (kind: 'ws-error' | 'ws-closed' | 'parse-error' | 'ws-create') => {
        // This effect run belongs to the container's state in the list it was
        // given; a change of state arrives as a new list and reruns it. A container that is not running
        // has no stream to lose, and its failure would otherwise be carried
        // into its next run.
        if (disposed || container.State !== 'running') return;
        if (!warnedOnce.has(container.Id)) {
          warnedOnce.add(container.Id);
          console.warn('[useContainerStats] stats stream failure:', { kind, containerId: container.Id });
        }
        setFailedIds(prev => (prev.has(container.Id) ? prev : new Set(prev).add(container.Id)));
      };

      const clearFailure = () => {
        setFailedIds(prev => {
          if (!prev.has(container.Id)) return prev;
          const next = new Set(prev);
          next.delete(container.Id);
          return next;
        });
      };

      try {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws${nodeQuery}`);
        wsMap[container.Id] = ws;

        ws.onopen = () => ws.send(JSON.stringify({
          action: 'streamStats',
          containerId: container.Id,
          nodeId: activeNodeId ?? undefined,
        }));

        ws.onerror = () => recordFailure('ws-error');
        ws.onclose = (event) => {
          // 1000 normal, 1001 going-away are expected during cleanup or navigation.
          if (event.code !== 1000 && event.code !== 1001) recordFailure('ws-closed');
        };

        ws.onmessage = (event) => {
          if (disposed) return;
          try {
            const sample = readStatsSample(JSON.parse(event.data));
            if (!sample) return;

            const cpuPercent = sample.cpuPercent.toFixed(2);
            const ramUsage = (sample.memBytes / (1024 * 1024)).toFixed(2) + ' MB';
            const currentRx = sample.rx;
            const currentTx = sample.tx;

            const prevRaw = rawBytesRef.current[container.Id];
            const rxRate = prevRaw ? Math.max(0, currentRx - prevRaw.lastRx) : 0;
            const txRate = prevRaw ? Math.max(0, currentTx - prevRaw.lastTx) : 0;
            rawBytesRef.current[container.Id] = { lastRx: currentRx, lastTx: currentTx };

            pendingStatsRef.current[container.Id] = {
              cpu: cpuPercent + '%',
              ram: ramUsage,
              net: `${formatBytes(rxRate)}/s ↓ / ${formatBytes(txRate)}/s ↑`,
              lastRx: currentRx,
              lastTx: currentTx,
              cpuNum: parseFloat(cpuPercent) || 0,
              memNum: sample.memBytes / (1024 * 1024),
              netInNum: rxRate,
              netOutNum: txRate,
            };
            clearFailure();
          } catch {
            recordFailure('parse-error');
          }
        };
      } catch {
        recordFailure('ws-create');
      }
    });

    const flushInterval = setInterval(() => {
      const pending = pendingStatsRef.current;
      if (Object.keys(pending).length === 0) return;
      pendingStatsRef.current = {};

      setContainerStats(prev => {
        const next = { ...prev };
        const HISTORY_CAP = 60;
        for (const [id, newStats] of Object.entries(pending)) {
          const prior = prev[id]?.history ?? { cpu: [], mem: [], netIn: [], netOut: [] };
          const history = {
            cpu: [...prior.cpu, newStats.cpuNum].slice(-HISTORY_CAP),
            mem: [...prior.mem, newStats.memNum].slice(-HISTORY_CAP),
            netIn: [...prior.netIn, newStats.netInNum].slice(-HISTORY_CAP),
            netOut: [...prior.netOut, newStats.netOutNum].slice(-HISTORY_CAP),
          };
          next[id] = {
            cpu: newStats.cpu, ram: newStats.ram, net: newStats.net,
            lastRx: newStats.lastRx, lastTx: newStats.lastTx,
            history,
          };
        }
        return next;
      });
    }, 1500);

    return () => {
      disposed = true;
      clearInterval(flushInterval);
      pendingStatsRef.current = {};
      Object.values(wsMap).forEach(ws => {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(1000); } catch { /* ignore */ }
      });
    };
  }, [containers, activeNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The effect drops a container's flag once it is no longer running. This
  // filter covers the render between a list update and that effect, so the chip
  // never shows for a container that just stopped.
  const streamFailing = failedIds.size > 0
    && (containers || []).some(c => c?.State === 'running' && failedIds.has(c.Id));

  return { stats: containerStats, error: streamFailing ? STATS_UNAVAILABLE_MESSAGE : null };
}
