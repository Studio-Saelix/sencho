import { cn } from '@/lib/utils';
import { nodeConnection, PIN_TITLE } from './nodeConnection';

interface NodeConnectionPinProps {
    type: 'local' | 'remote';
    mode?: string | null;
    /** Layout only (position, shrink); do not pass type or color classes. */
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
