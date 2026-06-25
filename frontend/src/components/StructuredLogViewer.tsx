import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Download, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLogChipColorMode } from '@/hooks/use-log-chip-color-mode';
import { hashLabel } from '@/lib/label-colors';

interface StructuredLogViewerProps {
  stackName: string;
}

type LogLevel = 'info' | 'warn' | 'err';

interface LogRow {
  id: number;
  ts: string | null;
  level: LogLevel;
  message: string;
  /** Normalized service name extracted from the log prefix, or null for synthetic / old-format rows. */
  containerName: string | null;
  /** True when this row was synthesized by the client (e.g. reconnect sentinel). */
  synthetic?: boolean;
}

type Filter = 'all' | LogLevel;

const BUFFER_CAP = 10_000;
const TIMESTAMP_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/;
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
const PREFIX_REGEX = /^([a-zA-Z0-9_.-]+)(?:\s+\|\s+)/;
const ERROR_REGEX = /\b(ERROR|ERR|FATAL|Exception)\b/i;
const WARN_REGEX = /\b(WARN|WARNING|WRN)\b/i;

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s cap. After each successful
// open the schedule resets. docker logs -f has no resumable offset, so on
// reconnect we drop a synthetic sentinel row to mark the gap rather than
// pretend nothing was missed.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

function parseLine(raw: string): Omit<LogRow, 'id'> {
  let stripped = raw.replace(ANSI_REGEX, '').replace(/[\r\n]+$/, '');
  let containerName: string | null = null;
  const prefixMatch = stripped.match(PREFIX_REGEX);
  if (prefixMatch) {
    containerName = prefixMatch[1];
    stripped = stripped.slice(prefixMatch[0].length);
  }
  const match = stripped.match(TIMESTAMP_REGEX);
  const ts = match ? match[1] : null;
  const body = match ? match[2] : stripped;
  let level: LogLevel = 'info';
  if (ERROR_REGEX.test(body)) level = 'err';
  else if (WARN_REGEX.test(body)) level = 'warn';
  return { ts, level, message: body, containerName };
}

function formatTs(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function StructuredLogViewer({ stackName }: StructuredLogViewerProps) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [following, setFollowing] = useState(true);
  const [connectionState, setConnectionState] = useState<'connecting' | 'open' | 'reconnecting'>('connecting');
  const [chipColorMode] = useLogChipColorMode();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const rowIdRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<LogRow[]>([]);

  useEffect(() => { followingRef.current = following; }, [following]);

  useEffect(() => {
    // Reset state accumulated from the previous stack before connecting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows([]);
    rowIdRef.current = 0;
    setFollowing(true);
    followingRef.current = true;

    const cleanStackName = stackName.replace(/\.(yml|yaml)$/, '');
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const activeNodeId = localStorage.getItem('sencho-active-node') || '';
    const wsUrl = `${wsProtocol}//${window.location.host}/api/stacks/${cleanStackName}/logs${activeNodeId ? `?nodeId=${activeNodeId}` : ''}`;

    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let rafId = 0;

    const flushPending = () => {
      rafId = 0;
      if (pendingRef.current.length === 0) return;
      const incoming = pendingRef.current;
      pendingRef.current = [];
      setRows((prev) => {
        const merged = prev.concat(incoming);
        return merged.length > BUFFER_CAP ? merged.slice(merged.length - BUFFER_CAP) : merged;
      });
    };
    const scheduleFlush = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(flushPending);
    };

    const pushSyntheticRow = (level: LogLevel, message: string) => {
      rowIdRef.current += 1;
      pendingRef.current.push({
        id: rowIdRef.current,
        ts: new Date().toISOString(),
        level,
        message,
        containerName: null,
        synthetic: true,
      });
      scheduleFlush();
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      if (attempt === 0) setConnectionState('connecting');

      ws.onopen = () => {
        if (closedByCleanup) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (attempt > 0) {
          // Recovered from a disconnect. Mark the gap so the operator knows
          // older lines may be missing - docker logs -f has no offset we
          // could resume from.
          pushSyntheticRow('warn', '--- reconnected; older lines may be missing ---');
        }
        attempt = 0;
        setConnectionState('open');
      };

      ws.onmessage = (event) => {
        if (closedByCleanup) return;
        const text = typeof event.data === 'string' ? event.data : '';
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          const parsed = parseLine(line);
          if (!parsed.message) continue;
          rowIdRef.current += 1;
          pendingRef.current.push({ id: rowIdRef.current, ...parsed });
        }
        scheduleFlush();
      };

      ws.onerror = () => { /* fall through to onclose, which schedules reconnect */ };

      ws.onclose = () => {
        if (closedByCleanup) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        setConnectionState('reconnecting');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!closedByCleanup) connect();
        }, delay);
      };
    };

    connect();

    return () => {
      closedByCleanup = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
      wsRef.current = null;
      pendingRef.current = [];
    };
  }, [stackName]);

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter(r => r.level === filter);
  }, [rows, filter]);

  const errCount = useMemo(() => rows.reduce((n, r) => r.level === 'err' ? n + 1 : n, 0), [rows]);

  // Auto-scroll to bottom when following.
  useEffect(() => {
    if (!followingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    if (atBottom !== followingRef.current) {
      followingRef.current = atBottom;
      setFollowing(atBottom);
    }
  };

  const resumeFollow = () => {
    setFollowing(true);
    followingRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const downloadLogs = () => {
    const text = rows.map(r =>
      r.containerName
        ? `[${r.containerName}] ${r.ts ?? ''} ${r.level.toUpperCase()} ${r.message}`.trim()
        : `${r.ts ?? ''} ${r.level.toUpperCase()} ${r.message}`.trim(),
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stackName.replace(/\.(yml|yaml)$/, '')}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const label = `logs · ${stackName.replace(/\.(yml|yaml)$/, '')}`;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-muted bg-card/40">
      <div className="flex items-center justify-between border-b border-muted px-3 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-xs text-stat-subtitle truncate">{label}</span>
          {connectionState === 'reconnecting' ? (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-warning" role="status">
              <RefreshCw className="h-2.5 w-2.5 animate-spin" strokeWidth={2} />
              reconnecting…
            </span>
          ) : following ? (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-[pulse_2.4s_ease-in-out_infinite]" />
              following
            </span>
          ) : (
            <button
              type="button"
              onClick={resumeFollow}
              className="text-[10px] font-mono text-stat-subtitle hover:text-foreground transition-colors underline-offset-2 hover:underline"
            >
              resume follow
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'info', 'warn', 'err'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                filter === f ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-foreground',
              )}
            >
              {f}{f === 'err' && errCount > 0 ? ` ${errCount}` : ''}
            </button>
          ))}
          <div className="mx-1 h-4 w-px bg-muted" />
          <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={downloadLogs} aria-label="Download logs">
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[1.5]"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-stat-subtitle">Waiting for log output…</div>
        ) : (
          filtered.map(row => (
            <div
              key={row.id}
              className={cn(
                'grid grid-cols-[64px_44px_1fr] items-start gap-2 border-l-2 border-transparent px-3 py-0.5',
                row.level === 'err' && 'border-destructive bg-destructive/[0.04]',
                row.level === 'warn' && 'bg-warning/[0.04]',
                row.synthetic && 'opacity-70',
              )}
            >
              <span className="text-stat-subtitle">{formatTs(row.ts)}</span>
              <span className={cn(
                'font-mono text-[9px] uppercase tracking-wide',
                row.level === 'err' && 'text-destructive',
                row.level === 'warn' && 'text-warning',
                row.level === 'info' && 'text-success/80',
              )}>
                {row.level}
              </span>
              <span className="whitespace-pre-wrap break-all text-foreground/90">
                {row.containerName && (
                  <span
                    className={cn(
                      'font-mono text-[10px] tracking-wide rounded px-1.5 py-px mr-1.5 select-none',
                      chipColorMode === 'per-service' ? 'border' : 'text-brand/80 bg-brand/10',
                    )}
                    title={row.containerName}
                    style={
                      chipColorMode === 'per-service'
                        ? {
                            backgroundColor: `var(--label-${hashLabel(row.containerName)}-bg)`,
                            color: `var(--label-${hashLabel(row.containerName)})`,
                            borderColor: `color-mix(in oklch, var(--label-${hashLabel(row.containerName)}) 30%, transparent)`,
                          }
                        : undefined
                    }
                  >
                    {row.containerName}
                  </span>
                )}
                {row.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
