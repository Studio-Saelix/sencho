import { useState, useEffect, useCallback, Fragment, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sparkline } from '@/components/ui/sparkline';
import { ChevronLeft, ChevronRight, Search, ScrollText, RefreshCw, Download, ChevronDown, Activity, Table2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

type AnomalyFlag = 'unusual_hour' | 'new_ip' | 'first_seen_actor';

interface AuditEntry {
    id: number;
    timestamp: number;
    username: string;
    method: string;
    path: string;
    status_code: number;
    node_id: number | null;
    ip_address: string;
    summary: string;
    flags?: AnomalyFlag[];
}

interface AuditStatTile {
    value: number | null;
    label: string;
    detail: string | null;
    severity: 'ok' | 'warn' | 'alert';
}

interface AuditStats {
    events_24h: AuditStatTile;
    actors_24h: AuditStatTile;
    failure_rate: AuditStatTile;
    unusual_hour: AuditStatTile;
    activity_by_hour: number[];
    failures_by_hour: number[];
}

const methodOptions = [
    { value: 'all', label: 'All Methods' },
    { value: 'POST', label: 'POST' },
    { value: 'PUT', label: 'PUT' },
    { value: 'DELETE', label: 'DELETE' },
    { value: 'PATCH', label: 'PATCH' },
];

const SEVERITY_DOT: Record<'ok' | 'warn' | 'alert', string> = {
    ok: 'bg-success',
    warn: 'bg-warning',
    alert: 'bg-destructive',
};

const SEVERITY_TEXT: Record<'ok' | 'warn' | 'alert', string> = {
    ok: 'text-stat-value',
    warn: 'text-warning',
    alert: 'text-destructive',
};

const FLAG_LABEL: Record<AnomalyFlag, string> = {
    unusual_hour: 'unusual hour',
    new_ip: 'new ip',
    first_seen_actor: 'first seen',
};

function entrySeverity(statusCode: number): 'ok' | 'warn' | 'alert' {
    if (statusCode >= 400) return 'alert';
    if (statusCode >= 300) return 'warn';
    return 'ok';
}

function formatRelative(ts: number, now: number): string {
    const diff = now - ts;
    if (diff < 60_000) return 'now';
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function formatDayBanner(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatClock(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// These views fetch localOnly, so a 401 is the user's own expired session,
// which apiFetch already turns into a global logout. Skip the redundant
// load-failure toast in that case so logout does not stack toasts.
function isExpiredSession(err: unknown): boolean {
    return err instanceof Error && err.message === 'Unauthorized';
}

export function AuditLogView() {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState<'stream' | 'table'>('stream');
    const [stats, setStats] = useState<AuditStats | null>(null);
    const [searchFilter, setSearchFilter] = useState('');
    const [methodFilter, setMethodFilter] = useState('all');
    const [fromDate, setFromDate] = useState<Date | undefined>();
    const [toDate, setToDate] = useState<Date | undefined>();
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const limit = 50;

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(id);
    }, []);

    const buildFilterParams = useCallback(() => {
        const params = new URLSearchParams();
        if (searchFilter) params.set('search', searchFilter);
        if (methodFilter !== 'all') params.set('method', methodFilter);
        if (fromDate) {
            const start = new Date(fromDate);
            start.setHours(0, 0, 0, 0);
            params.set('from', String(start.getTime()));
        }
        if (toDate) {
            const end = new Date(toDate);
            end.setHours(23, 59, 59, 999);
            params.set('to', String(end.getTime()));
        }
        return params;
    }, [searchFilter, methodFilter, fromDate, toDate]);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const params = buildFilterParams();
            params.set('page', String(page));
            params.set('limit', String(limit));
            params.set('with_anomalies', '1');

            const res = await apiFetch(`/audit-log?${params}`, { localOnly: true });
            if (res.ok) {
                const data = await res.json();
                setEntries(data.entries);
                setTotal(data.total);
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to load audit log.');
            }
        } catch (err) {
            console.error('[AuditLog] Failed to fetch:', err);
            if (!isExpiredSession(err)) {
                toast.error('Failed to load audit log.');
            }
        } finally {
            setLoading(false);
        }
    }, [page, buildFilterParams]);

    const fetchStats = useCallback(async () => {
        try {
            const res = await apiFetch('/audit-log/stats', { localOnly: true });
            if (res.ok) {
                setStats(await res.json());
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to load audit stats.');
            }
        } catch (err) {
            console.error('[AuditLog] Failed to fetch stats:', err);
            if (!isExpiredSession(err)) {
                toast.error('Failed to load audit stats.');
            }
        }
    }, []);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    useEffect(() => {
        if (view === 'stream') fetchStats();
    }, [view, fetchStats]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    const methodBadgeVariant = (method: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
        switch (method) {
            case 'POST': return 'default';
            case 'PUT': case 'PATCH': return 'secondary';
            case 'DELETE': return 'destructive';
            default: return 'outline';
        }
    };

    const statusColor = (code: number): string => {
        if (code >= 200 && code < 300) return 'text-success';
        if (code >= 400 && code < 500) return 'text-warning';
        if (code >= 500) return 'text-destructive';
        return 'text-muted-foreground';
    };

    const handleExport = async (format: 'csv' | 'json') => {
        try {
            const params = buildFilterParams();
            params.set('format', format);
            const res = await apiFetch(`/audit-log/export?${params}`, { localOnly: true });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Export failed.');
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'json'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('[AuditLog] Export failed:', err);
            toast.error('Export failed.');
        }
    };

    const groupedEntries = useMemo(() => {
        const groups: { key: string; day: number; entries: AuditEntry[] }[] = [];
        for (const entry of entries) {
            const key = dayKey(entry.timestamp);
            const last = groups[groups.length - 1];
            if (last && last.key === key) {
                last.entries.push(entry);
            } else {
                groups.push({ key, day: entry.timestamp, entries: [entry] });
            }
        }
        return groups;
    }, [entries]);

    return (
        <div className="flex-1 flex flex-col gap-4 p-6 overflow-auto">
            <Card className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel">
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <ScrollText className="w-5 h-5" strokeWidth={1.5} />
                            <CardTitle>Audit Log</CardTitle>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="flex items-center rounded-md border border-card-border bg-card/40 p-0.5 mr-1">
                                <Button
                                    variant={view === 'stream' ? 'secondary' : 'ghost'}
                                    size="sm"
                                    className="h-7 px-2 gap-1.5 text-xs"
                                    onClick={() => setView('stream')}
                                >
                                    <Activity className="w-3.5 h-3.5" strokeWidth={1.5} />
                                    Stream
                                </Button>
                                <Button
                                    variant={view === 'table' ? 'secondary' : 'ghost'}
                                    size="sm"
                                    className="h-7 px-2 gap-1.5 text-xs"
                                    onClick={() => setView('table')}
                                >
                                    <Table2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                    Table
                                </Button>
                            </div>
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" size="sm" className="border-border">
                                        <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                                        Export
                                        <ChevronDown className="w-3 h-3 ml-1" strokeWidth={1.5} />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => handleExport('csv')}>Export as CSV</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleExport('json')}>Export as JSON</DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <Button variant="outline" size="sm" className="border-border" onClick={() => { fetchLogs(); if (view === 'stream') fetchStats(); }} disabled={loading}>
                                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                                Refresh
                            </Button>
                        </div>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                        Track all mutating actions across your Sencho instance. {total > 0 && `${total} total entries.`}
                    </p>
                </CardHeader>
                <CardContent>
                    {view === 'stream' ? (
                        <StreamView
                            stats={stats}
                            loading={loading && entries.length === 0}
                            groups={groupedEntries}
                            now={now}
                            totalPages={totalPages}
                            page={page}
                            onPage={setPage}
                        />
                    ) : (
                        <>
                            <div className="flex items-center gap-3 mb-4 flex-wrap">
                                <div className="relative flex-1 min-w-[200px] max-w-xs">
                                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
                                    <Input
                                        placeholder="Search actions, paths, users..."
                                        value={searchFilter}
                                        onChange={(e) => { setSearchFilter(e.target.value); setPage(1); }}
                                        className="pl-8"
                                    />
                                </div>
                                <Combobox
                                    options={methodOptions}
                                    value={methodFilter}
                                    onValueChange={(v) => { setMethodFilter(v || 'all'); setPage(1); }}
                                    placeholder="Method"
                                    className="w-[140px]"
                                />
                                <DatePicker
                                    value={fromDate}
                                    onChange={(d) => { setFromDate(d); setPage(1); }}
                                    placeholder="From"
                                    className="w-[160px]"
                                />
                                <DatePicker
                                    value={toDate}
                                    onChange={(d) => { setToDate(d); setPage(1); }}
                                    placeholder="To"
                                    className="w-[160px]"
                                />
                            </div>

                            <div className="rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[170px]">Timestamp</TableHead>
                                            <TableHead className="w-[110px]">User</TableHead>
                                            <TableHead className="w-[80px]">Method</TableHead>
                                            <TableHead>Action</TableHead>
                                            <TableHead className="w-[70px]">Status</TableHead>
                                            <TableHead className="w-[70px]">Node</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {loading && entries.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                                                    Loading...
                                                </TableCell>
                                            </TableRow>
                                        ) : entries.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                                                    No audit log entries found.
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            entries.map((entry) => (
                                                <Fragment key={entry.id}>
                                                    <TableRow
                                                        className="cursor-pointer hover:bg-muted/50"
                                                        onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                                                    >
                                                        <TableCell className="text-xs text-muted-foreground font-mono tabular-nums">
                                                            {new Date(entry.timestamp).toLocaleString()}
                                                        </TableCell>
                                                        <TableCell className="font-medium text-sm">
                                                            {entry.username}
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant={methodBadgeVariant(entry.method)} className="text-xs font-mono">
                                                                {entry.method}
                                                            </Badge>
                                                        </TableCell>
                                                        <TableCell className="text-sm">
                                                            {entry.summary}
                                                        </TableCell>
                                                        <TableCell className={`text-sm font-mono tabular-nums ${statusColor(entry.status_code)}`}>
                                                            {entry.status_code}
                                                        </TableCell>
                                                        <TableCell className="text-sm text-muted-foreground font-mono tabular-nums">
                                                            {entry.node_id ?? '-'}
                                                        </TableCell>
                                                    </TableRow>
                                                    {expandedId === entry.id && (
                                                        <TableRow>
                                                            <TableCell colSpan={6} className="bg-muted/30 px-6 py-3">
                                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                                                    <div>
                                                                        <span className="text-muted-foreground text-xs block">Request Path</span>
                                                                        <span className="font-mono text-xs">{entry.path}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-muted-foreground text-xs block">IP Address</span>
                                                                        <span className="font-mono text-xs tabular-nums">{entry.ip_address || '-'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-muted-foreground text-xs block">Node ID</span>
                                                                        <span className="font-mono text-xs tabular-nums">{entry.node_id ?? 'Local'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-muted-foreground text-xs block">Entry ID</span>
                                                                        <span className="font-mono text-xs tabular-nums">#{entry.id}</span>
                                                                    </div>
                                                                </div>
                                                            </TableCell>
                                                        </TableRow>
                                                    )}
                                                </Fragment>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </div>

                            {totalPages > 1 && (
                                <div className="flex items-center justify-between mt-4">
                                    <p className="text-sm text-muted-foreground font-mono tabular-nums">
                                        Page {page} of {totalPages}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                                            <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                                            <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

interface StreamViewProps {
    stats: AuditStats | null;
    loading: boolean;
    groups: { key: string; day: number; entries: AuditEntry[] }[];
    now: number;
    page: number;
    totalPages: number;
    onPage: (n: number) => void;
}

function StreamView({ stats, loading, groups, now, page, totalPages, onPage }: StreamViewProps) {
    const tiles: AuditStatTile[] = stats
        ? [stats.events_24h, stats.actors_24h, stats.failure_rate, stats.unusual_hour]
        : [];
    const failures = stats?.failures_by_hour ?? [];
    const hasFailurePoints = failures.some(f => f > 0);

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 rounded-md border border-card-border bg-card/40 overflow-hidden">
                {tiles.length === 0 ? (
                    Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="px-4 py-3 border-r last:border-r-0 border-card-border">
                            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle mb-1">&nbsp;</div>
                            <div className="h-8 flex items-center">
                                <span className="text-stat-subtitle text-xs font-mono">·</span>
                            </div>
                            <div className="h-3.5" />
                        </div>
                    ))
                ) : (
                    tiles.map((tile, idx) => (
                        <div key={tile.label} className="px-4 py-3 border-b last:border-b-0 sm:border-b-0 sm:[&:nth-child(-n+2)]:border-b lg:[&:nth-child(-n+2)]:border-b-0 border-r last:border-r-0 border-card-border">
                            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle mb-1">
                                {tile.label}
                            </div>
                            <div className="flex items-end gap-2">
                                <span className={`font-display italic text-3xl leading-none tabular-nums ${SEVERITY_TEXT[tile.severity]}`}>
                                    {tile.value === null
                                        ? '·'
                                        : idx === 2
                                            ? `${tile.value}%`
                                            : idx === 3
                                                ? `${String(tile.value).padStart(2, '0')}:00`
                                                : tile.value}
                                </span>
                                {idx === 2 && hasFailurePoints && (
                                    <div className="w-14 h-6 ml-auto">
                                        <Sparkline
                                            points={failures}
                                            stroke={tile.severity === 'alert' ? 'var(--destructive)' : tile.severity === 'warn' ? 'var(--warning)' : 'var(--brand)'}
                                            fill={tile.severity === 'alert' ? 'var(--destructive)' : tile.severity === 'warn' ? 'var(--warning)' : 'var(--brand)'}
                                            showPeak={false}
                                        />
                                    </div>
                                )}
                            </div>
                            <div className="mt-1 text-[11px] font-mono text-stat-subtitle">
                                {tile.detail ?? '\u00a0'}
                            </div>
                        </div>
                    ))
                )}
            </div>

            {loading ? (
                <div className="py-10 text-center text-muted-foreground text-sm">Loading audit stream...</div>
            ) : groups.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground text-sm">No audit log entries found.</div>
            ) : (
                <div className="space-y-5">
                    {groups.map(group => (
                        <div key={group.key} className="space-y-1">
                            <div className="flex items-baseline gap-2 pb-1 border-b border-card-border">
                                <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-stat-subtitle">
                                    {formatDayBanner(group.day)}
                                </span>
                                <span className="text-[10px] font-mono text-stat-subtitle/70">
                                    {group.entries.length} {group.entries.length === 1 ? 'event' : 'events'}
                                </span>
                            </div>
                            <div className="divide-y divide-card-border/40">
                                {group.entries.map(entry => (
                                    <StreamRow key={entry.id} entry={entry} now={now} />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {totalPages > 1 && (
                <div className="flex items-center justify-between pt-1">
                    <p className="text-xs text-muted-foreground font-mono tabular-nums">
                        Page {page} of {totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>
                            <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>
                            <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

interface StreamRowProps {
    entry: AuditEntry;
    now: number;
}

function StreamRow({ entry, now }: StreamRowProps) {
    const severity = entrySeverity(entry.status_code);
    const [verb, ...rest] = entry.summary.split(' ');
    const target = rest.join(' ');
    const flags = entry.flags ?? [];
    const rowTint =
        severity === 'alert' ? 'bg-destructive/4' :
        severity === 'warn' ? 'bg-warning/4' :
        '';

    return (
        <div className={`grid grid-cols-[72px_10px_1fr_auto] gap-3 items-start px-2 py-[var(--density-cell-y)] rounded-sm ${rowTint}`}>
            <div className="text-[11px] font-mono text-stat-subtitle tabular-nums leading-4 pt-0.5">
                {formatRelative(entry.timestamp, now)}
            </div>
            <div className="pt-2">
                <div className={`w-2 h-2 rounded-full ${SEVERITY_DOT[severity]}`} />
            </div>
            <div className="min-w-0">
                <div className="text-sm leading-snug">
                    <span className="font-semibold">{entry.username || 'system'}</span>
                    <span className="text-muted-foreground"> {verb.toLowerCase()} </span>
                    <span className="font-semibold">{target || entry.path}</span>
                </div>
                <div className="text-[11px] font-mono text-stat-subtitle mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="tabular-nums">{formatClock(entry.timestamp)}</span>
                    <span>·</span>
                    <span>{entry.node_id == null ? 'local' : `node ${entry.node_id}`}</span>
                    <span>·</span>
                    <span className={severity === 'alert' ? 'text-destructive' : severity === 'warn' ? 'text-warning' : ''}>
                        {entry.status_code}
                    </span>
                    {entry.ip_address && (
                        <>
                            <span>·</span>
                            <span className="tabular-nums">{entry.ip_address}</span>
                        </>
                    )}
                    {flags.map(flag => (
                        <span key={flag} className="text-warning">· {FLAG_LABEL[flag]}</span>
                    ))}
                </div>
            </div>
            <div className="text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle pt-1 whitespace-nowrap">
                {entry.method} {entry.path.split('?')[0]}
            </div>
        </div>
    );
}
