import { cn } from '@/lib/utils';

export type NodeConnection = 'local' | 'proxy' | 'pilot';

const PIN_TITLE: Record<Exclude<NodeConnection, 'local'>, string> = {
    pilot: 'Pilot agent: this node connects out to the control instance over a tunnel',
    proxy: 'Proxy: the control instance reaches this node over its API',
};

/** How the control instance reaches a node: itself, over its API, or over a Pilot tunnel. */
export function nodeConnection(type: 'local' | 'remote', mode?: string | null): NodeConnection {
    if (type === 'local') return 'local';
    return mode === 'pilot_agent' ? 'pilot' : 'proxy';
}

interface NodeConnectionPinProps {
    type: 'local' | 'remote';
    mode?: string | null;
    /** Positioning only; the pin's own type and tone stay fixed. */
    className?: string;
}

/** The one identity pin a node carries: `★ Local`, or a muted `Proxy` / `Pilot`. */
export function NodeConnectionPin({ type, mode, className }: NodeConnectionPinProps) {
    const connection = nodeConnection(type, mode);
    if (connection === 'local') {
        return (
            <span className={cn('font-mono text-[9px] uppercase tracking-[0.22em] text-brand', className)}>
                ★ Local
            </span>
        );
    }
    return (
        <span
            className={cn('font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground', className)}
            title={PIN_TITLE[connection]}
        >
            {connection === 'pilot' ? 'Pilot' : 'Proxy'}
        </span>
    );
}
