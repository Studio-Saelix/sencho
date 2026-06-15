import { useEffect, useState, useMemo, useRef, useCallback, useLayoutEffect, memo } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PageMasthead } from '@/components/ui/PageMasthead';
import { SignalRail, type SignalTile } from '@/components/ui/SignalRail';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';
import { Download, Trash2, Search, Filter, AlertCircle, Pause, Play, SlidersHorizontal, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead } from '@/components/mobile/mobile-ui';
import { cn } from '@/lib/utils';

const MAX_LOG_ENTRIES = 2000;
const MAX_DISPLAY_ROWS = 300;
const POLL_FALLBACK_MS = 5000;
const LIVE_WINDOW_MS = 10_000;
const SPARK_BUCKET_MS = 1_000;
const SPARK_BUCKETS = 60;

type StreamFilter = 'ALL' | 'STDOUT' | 'STDERR';
type LevelFilter = 'ALL' | 'ERROR' | 'WARN' | 'INFO';

interface LogEntry {
    stackName: string;
    containerName: string;
    source: 'STDOUT' | 'STDERR';
    level: 'INFO' | 'WARN' | 'ERROR';
    message: string;
    timestampMs: number;
    // Client-assigned so the slice window can shift without re-keying existing rows.
    _id: number;
}

function timestampBandLabel(ms: number, now: number): string {
    const diff = now - ms;
    if (diff < 60_000) return 'NOW';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}M AGO`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}H AGO`;
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatUptime(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}H ${m.toString().padStart(2, '0')}M`;
    const s = totalSeconds % 60;
    return `${m}M ${s.toString().padStart(2, '0')}S`;
}

const levelDotClass: Record<LogEntry['level'], string> = {
    ERROR: 'bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_22%,transparent)]',
    WARN: 'bg-warning',
    INFO: 'bg-success/80',
};

const levelRowTint: Record<LogEntry['level'], string> = {
    ERROR: 'bg-destructive/[0.08]',
    WARN: 'bg-warning/[0.06]',
    INFO: '',
};

const STREAM_OPTIONS: SegmentedControlOption<StreamFilter>[] = [
    { value: 'ALL', label: 'All' },
    { value: 'STDOUT', label: 'Out' },
    { value: 'STDERR', label: 'Err' },
];

const LEVEL_OPTIONS: SegmentedControlOption<LevelFilter>[] = [
    { value: 'ALL', label: 'All' },
    { value: 'INFO', label: 'Info' },
    { value: 'WARN', label: 'Warn' },
    { value: 'ERROR', label: 'Error' },
];

interface GlobalObservabilityViewProps {
    /** Notifications + more-menu cluster for the mobile masthead, rehomed from the dropped TopBar. */
    headerActions?: ReactNode;
}

export function GlobalObservabilityView({ headerActions }: GlobalObservabilityViewProps = {}) {
    const isMobile = useIsMobile();
    const [searchOpen, setSearchOpen] = useState(false);
    const [fabOpen, setFabOpen] = useState(false);
    const { activeNode } = useNodes();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [allStacks, setAllStacks] = useState<string[]>([]);
    const [fetchError, setFetchError] = useState(false);
    const [lastEventAt, setLastEventAt] = useState<number | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [selectedStacks, setSelectedStacks] = useState<string[]>([]);
    const [streamFilter, setStreamFilter] = useState<StreamFilter>('ALL');
    const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
    const [clearedAt, setClearedAt] = useState<number>(0);

    const [isPaused, setIsPaused] = useState(false);
    const [pendingCount, setPendingCount] = useState(0);

    const bottomRef = useRef<HTMLDivElement>(null);
    const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
    const viewportRef = useRef<HTMLDivElement>(null);

    const bufferRef = useRef<LogEntry[]>([]);
    const logIdRef = useRef(0);
    // Mirrors isPaused for use inside stable interval callbacks.
    const pausedRef = useRef(isPaused);
    useEffect(() => { pausedRef.current = isPaused; }, [isPaused]);

    const [mountedAt, setMountedAt] = useState<number | null>(null);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const run = () => {
            const now = Date.now();
            setTick(now);
            setMountedAt(prev => prev ?? now);
        };
        const init = setTimeout(run, 0);
        const id = setInterval(run, 1000);
        return () => { clearTimeout(init); clearInterval(id); };
    }, []);

    useEffect(() => {
        const fetchStacks = async () => {
            try {
                const res = await apiFetch('/stacks');
                if (res.ok) {
                    const stacks: string[] = await res.json();
                    setAllStacks(stacks.sort());
                }
            } catch (err) {
                console.error('Failed to fetch stacks:', err);
            }
        };
        fetchStacks();
    }, []);

    const activeNodeId = activeNode?.id;
    useEffect(() => {
        const nodeParam = activeNodeId != null ? String(activeNodeId) : '';

        const ingest = (entries: LogEntry[]) => {
            entries.forEach(entry => { entry._id = ++logIdRef.current; });
            bufferRef.current.push(...entries);
            // Bound the buffer so a long pause doesn't grow memory unbounded.
            const excess = bufferRef.current.length - MAX_LOG_ENTRIES;
            if (excess > 0) bufferRef.current.splice(0, excess);
            setLastEventAt(Date.now());
        };

        const flush = () => {
            if (bufferRef.current.length === 0) return;
            if (pausedRef.current) {
                setPendingCount(bufferRef.current.length);
                return;
            }
            const batch = bufferRef.current.splice(0);
            setLogs(prev => {
                const lastPrev = prev[prev.length - 1]?.timestampMs ?? -Infinity;
                const firstBatch = batch[0]?.timestampMs ?? Infinity;
                const merged = [...prev, ...batch];
                // Fast path: SSE delivers monotonically, so skip the sort when the batch
                // is already ordered after prev's tail.
                if (firstBatch < lastPrev) {
                    merged.sort((a, b) => a.timestampMs - b.timestampMs);
                }
                return merged.slice(-MAX_LOG_ENTRIES);
            });
            setPendingCount(0);
        };

        let eventSource: EventSource | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let flushTimer: ReturnType<typeof setInterval> | null = null;
        let didOpen = false;
        let cancelled = false;

        const startPolling = () => {
            if (pollTimer || cancelled) return;
            const fetchBatch = async () => {
                try {
                    const res = await apiFetch('/logs/global');
                    if (!res.ok) {
                        setFetchError(true);
                        return;
                    }
                    const data: LogEntry[] = await res.json();
                    // Polling returns the current snapshot; replace rather than append
                    // to avoid duplicates across intervals.
                    data.forEach(entry => { entry._id = ++logIdRef.current; });
                    if (pausedRef.current) {
                        setPendingCount(data.length);
                    } else {
                        setLogs(data);
                    }
                    setLastEventAt(Date.now());
                    setFetchError(false);
                } catch (err) {
                    console.error('Failed to fetch global logs:', err);
                    setFetchError(true);
                }
            };
            fetchBatch();
            pollTimer = setInterval(fetchBatch, POLL_FALLBACK_MS);
        };

        try {
            eventSource = new EventSource(`/api/logs/global/stream?nodeId=${nodeParam}`);
            eventSource.onopen = () => { didOpen = true; setFetchError(false); };
            eventSource.onmessage = (event) => {
                try {
                    const entry: LogEntry = JSON.parse(event.data);
                    ingest([entry]);
                } catch { /* ignore parse errors */ }
            };
            eventSource.onerror = () => {
                if (!didOpen) {
                    eventSource?.close();
                    eventSource = null;
                    startPolling();
                } else if (eventSource?.readyState === EventSource.CLOSED) {
                    setFetchError(true);
                }
            };
            flushTimer = setInterval(flush, 500);
        } catch {
            startPolling();
        }

        return () => {
            cancelled = true;
            eventSource?.close();
            if (pollTimer) clearInterval(pollTimer);
            if (flushTimer) clearInterval(flushTimer);
            bufferRef.current = [];
        };
    }, [activeNodeId]);

    const handleStackToggle = (stack: string) => {
        setSelectedStacks(prev =>
            prev.includes(stack) ? prev.filter(s => s !== stack) : [...prev, stack]
        );
    };

    const handleClearLogs = () => {
        setClearedAt(Date.now());
    };

    const handleResume = () => {
        setIsPaused(false);
    };

    const filteredLogs = useMemo(() => {
        return logs.filter(log => {
            if (log.timestampMs < clearedAt) return false;
            if (selectedStacks.length > 0 && !selectedStacks.includes(log.stackName)) return false;
            if (streamFilter !== 'ALL' && log.source !== streamFilter) return false;
            if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                return log.message.toLowerCase().includes(query) ||
                    log.containerName.toLowerCase().includes(query) ||
                    log.stackName.toLowerCase().includes(query);
            }
            return true;
        });
    }, [logs, selectedStacks, streamFilter, levelFilter, searchQuery, clearedAt]);

    // Counters don't depend on tick, so they don't recompute each second.
    const counts = useMemo(() => {
        let errors = 0;
        let warns = 0;
        const containers = new Set<string>();
        for (const log of logs) {
            if (log.timestampMs < clearedAt) continue;
            containers.add(log.containerName);
            if (log.level === 'ERROR') errors += 1;
            else if (log.level === 'WARN') warns += 1;
        }
        return { errors, warns, containers: containers.size };
    }, [logs, clearedAt]);

    // Rolling 60s sparkline buckets; shifts with tick.
    const buckets = useMemo(() => {
        const windowStart = tick - SPARK_BUCKETS * SPARK_BUCKET_MS;
        const b = new Array<number>(SPARK_BUCKETS).fill(0);
        for (const log of logs) {
            if (log.timestampMs < clearedAt) continue;
            if (log.timestampMs >= windowStart) {
                const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((log.timestampMs - windowStart) / SPARK_BUCKET_MS));
                b[idx] += 1;
            }
        }
        return b;
    }, [logs, clearedAt, tick]);

    const signals = useMemo<SignalTile[]>(() => {
        const eventsPerMin = buckets.reduce((a, b) => a + b, 0);
        return [
            { kicker: 'EVENTS / MIN', value: String(eventsPerMin), tone: 'value', spark: buckets },
            { kicker: 'ERRORS', value: String(counts.errors), tone: counts.errors > 0 ? 'error' : 'subtitle' },
            { kicker: 'WARNINGS', value: String(counts.warns), tone: counts.warns > 0 ? 'warn' : 'subtitle' },
            { kicker: 'CONTAINERS', value: String(counts.containers), tone: 'value' },
        ];
    }, [buckets, counts]);

    const firstEventReceived = lastEventAt != null;
    const liveTone: 'live' | 'idle' = lastEventAt != null && (tick - lastEventAt) < LIVE_WINDOW_MS ? 'live' : 'idle';
    const masterTone = fetchError ? 'error' : liveTone;
    const stateWord = fetchError ? 'Offline' : masterTone === 'live' ? 'Streaming' : 'Idle';
    // The Logs tab is hub-only (hidden and redirected when a remote node is
    // active), so the feed always reflects the local hub.
    const kicker = 'LIVE LOGS · NODE · LOCAL';

    const mastheadMetadata = useMemo(() => {
        const uptime = mountedAt != null ? formatUptime(tick - mountedAt) : '—';
        return [
            { label: 'LAST EVENT', value: lastEventAt ? timestampBandLabel(lastEventAt, tick) : '—', tone: 'subtitle' as const },
            { label: 'SESSION', value: uptime, tone: 'subtitle' as const },
        ];
    }, [tick, lastEventAt, mountedAt]);

    useEffect(() => {
        if (isAutoScrollEnabled && bottomRef.current) {
            // Instant scroll avoids stacking smooth-scroll animations on every flush,
            // which wastes layout work and renderer memory.
            bottomRef.current.scrollIntoView({ behavior: 'instant' });
        }
    }, [filteredLogs, isAutoScrollEnabled]);

    const handleScroll = useCallback(() => {
        const el = viewportRef.current;
        if (!el) return;
        const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
        setIsAutoScrollEnabled(isAtBottom);
    }, []);

    useLayoutEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        el.addEventListener('scroll', handleScroll);
        return () => el.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    const handleDownload = () => {
        if (filteredLogs.length === 0) return;
        const blob = new Blob(
            [filteredLogs.map(l => `[${new Date(l.timestampMs).toISOString()}] [${l.stackName}/${l.containerName}] ${l.level}: ${l.message}`).join('\n')],
            { type: 'text/plain;charset=utf-8' },
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sencho-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const displayRows = filteredLogs.slice(-MAX_DISPLAY_ROWS);
    const overflow = Math.max(0, filteredLogs.length - displayRows.length);

    return (
        <div className="relative flex h-full w-full flex-col bg-background text-foreground">
            {isMobile ? (
                <Masthead
                    kicker="logs · local"
                    state={stateWord}
                    stateTone={fetchError ? 'destructive' : masterTone === 'live' ? 'success' : 'brand'}
                    live={masterTone === 'live'}
                    meta={`${buckets.reduce((a, b) => a + b, 0)}/min · ${counts.errors} err · ${counts.containers} containers`}
                    right={headerActions}
                />
            ) : (
                <>
                    <PageMasthead
                        kicker={kicker}
                        state={stateWord}
                        tone={masterTone}
                        pulsing={masterTone === 'live'}
                        metadata={mastheadMetadata}
                    />
                    <SignalRail tiles={signals} />
                </>
            )}

            {isMobile ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-4 py-2">
                    {searchOpen ? (
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stat-icon" strokeWidth={1.5} />
                            <Input
                                autoFocus
                                placeholder="Search logs..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onBlur={() => { if (!searchQuery) setSearchOpen(false); }}
                                className="h-9 w-full bg-transparent pl-8 text-sm focus-visible:ring-brand/50"
                            />
                        </div>
                    ) : (
                        <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" aria-label="Search logs" onClick={() => setSearchOpen(true)}>
                            <Search className="h-4 w-4" strokeWidth={1.5} />
                        </Button>
                    )}
                    {!searchOpen && (
                        <>
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" size="sm" className="h-9 gap-2">
                                        <Filter className="h-3.5 w-3.5" strokeWidth={1.5} />
                                        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                                            Stacks · {selectedStacks.length === 0 ? 'All' : selectedStacks.length}
                                        </span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="w-52">
                                    {allStacks.map(stack => (
                                        <DropdownMenuCheckboxItem key={stack} checked={selectedStacks.includes(stack)} onCheckedChange={() => handleStackToggle(stack)}>
                                            {stack}
                                        </DropdownMenuCheckboxItem>
                                    ))}
                                    {allStacks.length === 0 && (
                                        <div className="px-2 py-1.5 text-sm text-stat-subtitle">No stacks found</div>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" size="sm" className="h-9 gap-2">
                                        <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                                        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Filters</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                    <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Stream</DropdownMenuLabel>
                                    {STREAM_OPTIONS.map(o => (
                                        <DropdownMenuCheckboxItem key={o.value} checked={streamFilter === o.value} onCheckedChange={() => setStreamFilter(o.value)}>
                                            {o.label}
                                        </DropdownMenuCheckboxItem>
                                    ))}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Level</DropdownMenuLabel>
                                    {LEVEL_OPTIONS.map(o => (
                                        <DropdownMenuCheckboxItem key={o.value} checked={levelFilter === o.value} onCheckedChange={() => setLevelFilter(o.value)}>
                                            {o.label}
                                        </DropdownMenuCheckboxItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </>
                    )}
                </div>
            ) : (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-card-border bg-card px-[var(--density-row-x)] py-[var(--density-cell-y)]">
                <div className="relative flex items-center">
                    <Search className="absolute left-2.5 h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} />
                    <Input
                        placeholder="Search logs..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-8 w-56 bg-transparent pl-8 text-sm focus-visible:ring-brand/50"
                    />
                </div>

                <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 gap-2 text-sm shadow-btn-glow">
                            <Filter className="h-3.5 w-3.5" strokeWidth={1.5} />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                                Stacks · {selectedStacks.length === 0 ? 'All' : selectedStacks.length}
                            </span>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                        {allStacks.map(stack => (
                            <DropdownMenuCheckboxItem
                                key={stack}
                                checked={selectedStacks.includes(stack)}
                                onCheckedChange={() => handleStackToggle(stack)}
                            >
                                {stack}
                            </DropdownMenuCheckboxItem>
                        ))}
                        {allStacks.length === 0 && (
                            <div className="px-2 py-1.5 text-sm text-stat-subtitle">No stacks found</div>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>

                <SegmentedControl
                    options={STREAM_OPTIONS}
                    value={streamFilter}
                    onChange={setStreamFilter}
                    ariaLabel="Stream filter"
                />
                <SegmentedControl
                    options={LEVEL_OPTIONS}
                    value={levelFilter}
                    onChange={setLevelFilter}
                    ariaLabel="Level filter"
                />
            </div>
            )}

            {fetchError && (
                <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/[0.06] px-[var(--density-row-x)] py-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                    Failed to fetch logs. Retrying...
                </div>
            )}

            <ScrollArea type="hover" className="relative min-h-0 flex-1" viewportRef={viewportRef}>
                <div className="relative px-[var(--density-row-x)] py-[var(--density-cell-y)]">
                    {!firstEventReceived && logs.length === 0 && (
                        <div className="flex flex-col items-center gap-2 py-16 text-stat-subtitle">
                            <span className="font-mono text-[10px] uppercase tracking-[0.22em]">Awaiting events</span>
                            <span className="text-xs italic">Logs will appear here as containers emit them.</span>
                        </div>
                    )}
                    {displayRows.length > 0 ? (
                        <>
                            {overflow > 0 && (
                                <div className="mb-3 border-b border-card-border pb-2 text-center">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
                                        Showing last {MAX_DISPLAY_ROWS} of {filteredLogs.length}
                                    </span>
                                </div>
                            )}
                            <LogBandedList rows={displayRows} now={tick} />
                            <div ref={bottomRef} />
                        </>
                    ) : (firstEventReceived && logs.length > 0) ? (
                        <div className="flex flex-col items-center gap-2 py-16 text-stat-subtitle">
                            <span className="font-mono text-[10px] uppercase tracking-[0.22em]">No matches</span>
                            <span className="text-xs italic">Try a broader filter to see logs again.</span>
                        </div>
                    ) : null}
                </div>
            </ScrollArea>

            {isMobile ? (
                <div className="pointer-events-none absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
                    {isPaused && pendingCount > 0 && (
                        <button
                            type="button"
                            onClick={handleResume}
                            className="pointer-events-auto rounded-full border border-brand/40 bg-brand/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-brand shadow-btn-glow"
                        >
                            {pendingCount} new · resume
                        </button>
                    )}
                    {fabOpen ? (
                        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-glass-border bg-popover/95 p-1 shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]">
                            <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => { setIsPaused(p => !p); setFabOpen(false); }} aria-label={isPaused ? 'Resume stream' : 'Pause stream'}>
                                {isPaused ? <Play className="h-4 w-4" strokeWidth={1.5} /> : <Pause className="h-4 w-4" strokeWidth={1.5} />}
                            </Button>
                            <Button variant="ghost" size="icon" className="h-10 w-10 text-stat-subtitle hover:text-stat-value" onClick={() => { handleClearLogs(); setFabOpen(false); }} aria-label="Clear log buffer">
                                <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-10 w-10 text-stat-subtitle hover:text-stat-value disabled:opacity-40" disabled={filteredLogs.length === 0} onClick={() => { handleDownload(); setFabOpen(false); }} aria-label="Download logs">
                                <Download className="h-4 w-4" strokeWidth={1.5} />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-10 w-10 text-stat-subtitle" onClick={() => setFabOpen(false)} aria-label="Close actions">
                                <X className="h-4 w-4" strokeWidth={1.5} />
                            </Button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setFabOpen(true)}
                            aria-label="Log actions"
                            className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-glass-border bg-popover/95 text-stat-value shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]"
                        >
                            {isPaused ? <Play className="h-5 w-5" strokeWidth={1.5} /> : <SlidersHorizontal className="h-5 w-5" strokeWidth={1.5} />}
                        </button>
                    )}
                </div>
            ) : (
            <div className="pointer-events-none absolute bottom-4 right-6 z-10 flex items-center gap-2">
                {isPaused && pendingCount > 0 && (
                    <button
                        type="button"
                        onClick={handleResume}
                        className="pointer-events-auto rounded-md border border-brand/40 bg-brand/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-brand shadow-btn-glow transition-colors hover:bg-brand/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                    >
                        {pendingCount} new · resume
                    </button>
                )}
                <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-glass-border bg-popover/95 p-1 shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsPaused(p => !p)}
                        className="h-7 gap-2 px-2 text-xs"
                        aria-label={isPaused ? 'Resume stream' : 'Pause stream'}
                    >
                        {isPaused
                            ? <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                            : <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />}
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                            {isPaused ? 'Resume' : 'Pause'}
                        </span>
                    </Button>
                    <div className="h-5 w-px bg-card-border" />
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearLogs}
                        className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value"
                        aria-label="Clear log buffer"
                    >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Clear</span>
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleDownload}
                        disabled={filteredLogs.length === 0}
                        className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value disabled:opacity-40"
                        aria-label="Download logs"
                    >
                        <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Download</span>
                    </Button>
                </div>
            </div>
            )}
        </div>
    );
}

function LogBandedList({ rows, now }: { rows: LogEntry[]; now: number }) {
    const nodes: ReactNode[] = [];
    let prevBand: string | null = null;
    for (const log of rows) {
        const band = timestampBandLabel(log.timestampMs, now);
        if (band !== prevBand) {
            nodes.push(
                <div
                    key={`band-${log._id}`}
                    className="mt-2 mb-1 border-b border-card-border/60 pb-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle first:mt-0"
                >
                    {band}
                </div>,
            );
            prevBand = band;
        }
        nodes.push(<LogRow key={log._id} log={log} />);
    }
    return <>{nodes}</>;
}

const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
    return (
        <div
            className={cn(
                'flex items-start gap-3 rounded-sm px-2 py-[var(--density-cell-y)] font-mono text-xs leading-relaxed',
                levelRowTint[log.level],
                log.level === 'INFO' && 'hover:bg-accent/40',
            )}
        >
            <span
                aria-hidden="true"
                className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', levelDotClass[log.level])}
            />
            <span className="shrink-0 tabular-nums text-stat-subtitle">
                {new Date(log.timestampMs).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className="shrink-0 truncate text-brand" title={`${log.stackName}/${log.containerName}`}>
                {log.containerName}
            </span>
            <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all', log.source === 'STDERR' ? 'text-destructive/90' : 'text-stat-value/90')}>
                {log.message}
            </span>
        </div>
    );
});
