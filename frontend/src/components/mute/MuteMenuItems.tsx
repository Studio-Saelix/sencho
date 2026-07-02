import { BellOff, MoreVertical } from 'lucide-react';
import type { MouseEvent } from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { useStackMuteActions, useLabelMuteActions, useNodeMuteActions } from '@/hooks/useMuteRuleActions';

type StackMuteActions = ReturnType<typeof useStackMuteActions>;
type LabelMuteActions = ReturnType<typeof useLabelMuteActions>;
type NodeMuteActions = ReturnType<typeof useNodeMuteActions>;

export function StackMuteSubmenu({ actions }: { actions: StackMuteActions }) {
    if (!actions.canMute) return null;
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <BellOff className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Mute
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={actions.muteAll}>Mute notifications for this stack</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteDeploySuccess}>Mute deploy success noise</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteMonitor}>Mute monitor alerts for this stack</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.manage}>Manage stack mute rules</DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export function LabelMuteSubmenu({ actions }: { actions: LabelMuteActions }) {
    if (!actions.canMute) return null;
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <BellOff className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Mute
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={actions.muteAll}>Mute notifications for this label</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteExternal}>Mute external alerts for this label</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteLowPriority}>Mute low-priority stack alerts</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.manage}>Manage label mute rules</DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export function NodeMuteSubmenu({ actions }: { actions: NodeMuteActions }) {
    if (!actions.canMute) return null;
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <BellOff className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Mute
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={actions.muteAll}>Mute node notifications</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteUpdates}>Mute update notifications for this node</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteMonitor}>Mute monitor alerts on this node</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.manage}>Manage node mute rules</DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export function LabelGroupMuteKebab({
    actions,
}: {
    actions: LabelMuteActions;
}) {
    if (!actions.canMute) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Label mute actions"
                    className="inline-flex items-center justify-center w-5 h-5 rounded text-stat-icon hover:text-foreground hover:bg-glass-highlight/40 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                >
                    <MoreVertical className="w-3 h-3" strokeWidth={1.5} />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onClick={(e: MouseEvent) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={actions.muteAll}>Mute notifications for this label</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteExternal}>Mute external alerts for this label</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteLowPriority}>Mute low-priority stack alerts</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.manage}>Manage label mute rules</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function ActivityMuteKebab({ actions }: { actions: StackMuteActions }) {
    if (!actions.canMute) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Mute stack notifications"
                    className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors"
                >
                    <BellOff className="h-3 w-3" strokeWidth={1.5} />
                    mute
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={actions.muteAll}>Mute notifications for this stack</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteDeploySuccess}>Mute deploy success noise</DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.muteMonitor}>Mute monitor alerts for this stack</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.manage}>Manage stack mute rules</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
