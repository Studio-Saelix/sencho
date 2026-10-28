import { MoreVertical, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { PruneTarget } from '@/lib/prunePlan';

interface ResourcesActionsProps {
    /** Prune verbs are admin-only; the usage Retry is for everyone. */
    isAdmin: boolean;
    canReclaim: boolean;
    reclaimDisabled: boolean;
    usageFailed: boolean;
    onRetryUsage: () => void;
    onReclaim: () => void;
    onPrune: (target: Extract<PruneTarget, 'networks' | 'containers'>) => void;
}

/**
 * Page-level cleanup verbs for Resources: one primary (Reclaim), and the rarer
 * targets in an overflow. Images and volumes carry their own Prune in their
 * tab toolbars. Every prune verb opens its itemized preview as an overlay.
 */
export function ResourcesActions({
    isAdmin,
    canReclaim,
    reclaimDisabled,
    usageFailed,
    onRetryUsage,
    onReclaim,
    onPrune,
}: ResourcesActionsProps) {
    return (
        <div className="flex items-center gap-2">
            {usageFailed && (
                <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={onRetryUsage}>Retry disk usage</Button>
            )}
            {isAdmin && canReclaim && (
                <Button size="sm" className="gap-1.5 max-md:min-h-11" onClick={onReclaim} disabled={reclaimDisabled}>
                    <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Reclaim
                </Button>
            )}
            {isAdmin && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-9 w-9 p-0 max-md:min-h-11 max-md:w-11" aria-label="More cleanup actions">
                            <MoreVertical className="h-4 w-4" strokeWidth={1.5} />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onPrune('networks')}>Prune unused networks</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPrune('containers')}>Prune stopped containers</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}
