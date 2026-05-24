import { useEffect, useRef, useState } from 'react';
import type { ContainerInfo, ContainerStatsEntry } from '../EditorView';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export interface ContainerStatsHookResult {
  stats: Record<string, ContainerStatsEntry>;
  error: string | null;
}

export function useContainerStats(
  containers: ContainerInfo[],
  activeNodeId: number | null | undefined,
): ContainerStatsHookResult {
  const [containerStats, setContainerStats] = useState<Record<string, ContainerStatsEntry>>({});
  const [error, setError] = useState<string | null>(null);

  const pendingStatsRef = useRef<Record<string, {
    cpu: string; ram: string; net: string;
    lastRx: number; lastTx: number;
    cpuNum: number; memNum: number; netInNum: number; netOutNum: number;
  }>>({});

  const rawBytesRef = useRef<Record<string, { lastRx: number; lastTx: number }>>({});

  // Reset the error banner only on an actual node switch. Doing it inside the
  // main effect would clear the banner on every containers-array identity
  // change (which fires at the dashboard's refresh cadence) and cause the
  // banner to visibly flap against a persistently-flaky daemon.
  useEffect(() => {
    setError(null);
  }, [activeNodeId]);

  useEffect(() => {
    const wsMap: Record<string, WebSocket> = {};
    // Track which WSs have already emitted a console.warn for the lifetime of
    // this effect, so a flaky daemon does not spam the console at message rate.
    const warnedOnce = new Set<string>();

    const nodeQuery = activeNodeId != null ? `?nodeId=${activeNodeId}` : '';

    (containers || []).forEach(container => {
      if (!container?.Id) return;

      const recordFailure = (kind: 'ws-error' | 'ws-closed' | 'parse-error' | 'ws-create') => {
        if (!warnedOnce.has(container.Id)) {
          warnedOnce.add(container.Id);
          console.warn('[useContainerStats] stats stream failure:', { kind, containerId: container.Id });
        }
        setError('Container stats unavailable. The node may be unreachable.');
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
          try {
            const data = JSON.parse(event.data);
            if (!data.cpu_stats?.cpu_usage || !data.precpu_stats?.cpu_usage || !data.memory_stats?.usage) return;

            const cpuDelta = data.cpu_stats.cpu_usage.total_usage - data.precpu_stats.cpu_usage.total_usage;
            const systemDelta = (data.cpu_stats.system_cpu_usage || 0) - (data.precpu_stats.system_cpu_usage || 0);
            const onlineCpus = data.cpu_stats.online_cpus || 1;
            const cpuPercent = systemDelta > 0 ? ((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2) : '0.00';
            const ramUsage = (data.memory_stats.usage / (1024 * 1024)).toFixed(2) + ' MB';

            let currentRx = 0;
            let currentTx = 0;
            if (data.networks) {
              Object.values(data.networks as Record<string, { rx_bytes?: number; tx_bytes?: number }>).forEach(net => {
                currentRx += net.rx_bytes || 0;
                currentTx += net.tx_bytes || 0;
              });
            }

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
              memNum: data.memory_stats.usage / (1024 * 1024),
              netInNum: rxRate,
              netOutNum: txRate,
            };
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
      clearInterval(flushInterval);
      pendingStatsRef.current = {};
      Object.values(wsMap).forEach(ws => { try { ws.close(1000); } catch { /* ignore */ } });
    };
  }, [containers, activeNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { stats: containerStats, error };
}
