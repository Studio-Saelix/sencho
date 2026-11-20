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
 * cannot yield them: a stats section is absent, a required counter (current and
 * previous CPU totals, memory usage) is missing or not a finite number, memory
 * usage is zero, or any counter that is present is not a finite number. The CPU
 * totals may be zero (Docker's first streaming frame carries a zero previous
 * total); memory usage may not, since a container that is not running reports
 * zero. The caller drops a rejected frame: it must neither publish a metric nor
 * count as proof that the stream recovered. Counters Docker omits on some
 * runtimes (system CPU time, online CPUs, per-interface byte counts) may be
 * absent or null and read as 0. A null network entry throws, which the caller
 * reports as a parse failure.
 */
function readStatsSample(data: {
  cpu_stats?: { cpu_usage?: { total_usage?: unknown }; system_cpu_usage?: unknown; online_cpus?: unknown };
  precpu_stats?: { cpu_usage?: { total_usage?: unknown }; system_cpu_usage?: unknown };
  memory_stats?: { usage?: unknown };
  networks?: Record<string, { rx_bytes?: unknown; tx_bytes?: unknown }>;
}): StatsSample | null {
  // The truthiness test on memory usage is deliberate: zero (a container that is
  // not running) is rejected here. The CPU totals are checked as numbers below,
  // so a zero total passes.
  if (!data.cpu_stats?.cpu_usage || !data.precpu_stats?.cpu_usage || !data.memory_stats?.usage) return null;

  const cpuTotal = data.cpu_stats.cpu_usage.total_usage;
  const preCpuTotal = data.precpu_stats.cpu_usage.total_usage;
  const memUsage = data.memory_stats.usage;
  // Checked here, not after the arithmetic: the subtraction below coerces a
  // numeric string or null to a finite number, so the derived-value check at the
  // end could not tell it from a real reading. memUsage is never derived, so
  // this is its only type guard (its zero case is rejected above).
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
  // cpuPercent, rx and tx are derived, so they can still overflow to Infinity or
  // NaN although every input is finite.
  if (![cpuPercent, rx, tx].every(Number.isFinite)) return null;
  return { cpuPercent, memBytes: memUsage, rx, tx };
}

export interface ContainerStatsHookResult {
  stats: Record<string, ContainerStatsEntry>;
  error: string | null;
}

const STATS_UNAVAILABLE_MESSAGE = 'Container stats unavailable. The node may be unreachable.';

// Stream failures belong to one node: the failed IDs are stored with the node
// they were raised on, so a read for another node sees none even in the render
// before any effect has pruned them.
interface StreamFailures {
  nodeId: number | null | undefined;
  ids: ReadonlySet<string>;
}
const NO_IDS: ReadonlySet<string> = new Set();

export function useContainerStats(
  containers: ContainerInfo[],
  activeNodeId: number | null | undefined,
): ContainerStatsHookResult {
  const [containerStats, setContainerStats] = useState<Record<string, ContainerStatsEntry>>({});
  // IDs of running containers whose current stats stream has failed, tagged with
  // the node they belong to. A container leaves the set when it delivers a valid
  // sample, when a list shows it stopped or gone, or when the active node changes.
  const [failures, setFailures] = useState<StreamFailures>({ nodeId: activeNodeId, ids: NO_IDS });
  const failedIds = failures.nodeId === activeNodeId ? failures.ids : NO_IDS;

  const pendingStatsRef = useRef<Record<string, {
    cpu: string; ram: string; net: string;
    lastRx: number; lastTx: number;
    cpuNum: number; memNum: number; netInNum: number; netOutNum: number;
  }>>({});

  const rawBytesRef = useRef<Record<string, { lastRx: number; lastTx: number }>>({});

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

    // A node switch drops every failure. Opening another stack starts clean, and
    // a container this list shows as stopped or gone loses its flag, so its next
    // run starts clean. A container that stays listed as running keeps its flag
    // until a valid sample arrives, which also covers a restart (running to
    // running, same ID): the new stream's first valid sample clears it.
    const runningIds = new Set((containers || []).flatMap(c => (c?.Id && c.State === 'running' ? [c.Id] : [])));
    // Clearing everything on each containers-array identity change (the
    // dashboard's refresh cadence) would make the warning visibly flap against a
    // persistently-flaky daemon, so a refresh drops only what the list contradicts.
    setFailures(prev => {
      if (prev.nodeId !== activeNodeId) return { nodeId: activeNodeId, ids: NO_IDS };
      const kept = [...prev.ids].filter(id => runningIds.has(id));
      return kept.length === prev.ids.size ? prev : { nodeId: activeNodeId, ids: new Set(kept) };
    });

    (containers || []).forEach(container => {
      if (!container?.Id) return;

      const recordFailure = (kind: 'ws-error' | 'ws-closed' | 'parse-error' | 'ws-create') => {
        // This effect run belongs to the container's state in the list it was
        // given. A container that list shows as not running has no stream to
        // lose, and its failure would otherwise be carried into its next run.
        if (disposed || container.State !== 'running') return;
        if (!warnedOnce.has(container.Id)) {
          warnedOnce.add(container.Id);
          console.warn('[useContainerStats] stats stream failure:', { kind, containerId: container.Id });
        }
        setFailures(prev => {
          if (prev.nodeId === activeNodeId && prev.ids.has(container.Id)) return prev;
          const ids = new Set(prev.nodeId === activeNodeId ? prev.ids : NO_IDS);
          return { nodeId: activeNodeId, ids: ids.add(container.Id) };
        });
      };

      const clearFailure = () => {
        setFailures(prev => {
          if (prev.nodeId !== activeNodeId || !prev.ids.has(container.Id)) return prev;
          const ids = new Set(prev.ids);
          ids.delete(container.Id);
          return { nodeId: activeNodeId, ids };
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

  // The effect drops a container's flag once it is no longer running or the node
  // changes. The node tag above and this filter cover the render between a list
  // or node update and that effect, so the chip never shows for a container that
  // just stopped or for another node's failure.
  const streamFailing = failedIds.size > 0
    && (containers || []).some(c => c?.State === 'running' && failedIds.has(c.Id));

  return { stats: containerStats, error: streamFailing ? STATS_UNAVAILABLE_MESSAGE : null };
}
