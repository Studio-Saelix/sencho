import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { SystemSheet } from '@/components/ui/system-sheet';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { MeshActivityEvent } from '@/types/mesh';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function MeshActivitySheet({ open, onOpenChange }: Props) {
    const [events, setEvents] = useState<MeshActivityEvent[]>([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await apiFetch('/mesh/activity?limit=200', { localOnly: true });
                if (!res.ok) return;
                const body = await res.json() as { events: MeshActivityEvent[] };
                if (!cancelled) setEvents(body.events);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open]);

    const visible = events.filter((e) => {
        if (!filter) return true;
        const f = filter.toLowerCase();
        return (
            e.message.toLowerCase().includes(f) ||
            (e.alias?.toLowerCase().includes(f) ?? false) ||
            e.type.toLowerCase().includes(f)
        );
    });

    const mostRecentTs = events.length > 0 ? Math.max(...events.map((e) => e.ts)) : null;
    const meta = events.length === 0
        ? '0 events'
        : filter
            ? `${visible.length} of ${events.length} events`
            : `${events.length} events`;
    const footerContext = mostRecentTs ? `Last event ${formatTimeAgo(mostRecentTs)}` : 'No events yet';

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Mesh', 'Activity']}
            name="Mesh activity"
            meta={meta}
            footerContext={footerContext}
            size="lg"
        >
            <div className="space-y-4">
                <Input
                    placeholder="Filter by alias, type, or message"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="text-xs font-mono"
                />

                <div className="space-y-1">
                    {loading && (
                        <div className="flex items-center gap-2 text-stat-subtitle text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                        </div>
                    )}
                    {!loading && visible.length === 0 && (
                        <div className="text-xs text-stat-subtitle">No events.</div>
                    )}
                    {visible.slice().reverse().map((e, i) => (
                        <div key={i} className="grid grid-cols-[80px_70px_120px_1fr] gap-2 text-[11px] font-mono py-1 border-b border-card-border/50">
                            <span className="text-stat-subtitle tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
                            <span className={
                                e.level === 'error' ? 'text-destructive uppercase tracking-[0.18em]' :
                                    e.level === 'warn' ? 'text-warning uppercase tracking-[0.18em]' :
                                        'text-stat-subtitle uppercase tracking-[0.18em]'
                            }>{e.source}</span>
                            <span className="text-stat-value">{e.type}</span>
                            <span className="text-stat-value truncate" title={e.message}>{e.alias ? `[${e.alias}] ` : ''}{e.message}</span>
                        </div>
                    ))}
                </div>
            </div>
        </SystemSheet>
    );
}
