import { Ban } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PINNED_UPDATE_BLOCKED_FALLBACK } from './types';

interface PinnedUpdateBadgeProps {
    reason?: string | null;
    className?: string;
}

export function PinnedUpdateBadge({
    reason,
    className = 'text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground border-card-border/40 shrink-0',
}: PinnedUpdateBadgeProps) {
    return (
        <Badge className={className} title={reason ?? PINNED_UPDATE_BLOCKED_FALLBACK}>
            <Ban className="w-2.5 h-2.5 mr-0.5" strokeWidth={1.5} /> Pinned
        </Badge>
    );
}
