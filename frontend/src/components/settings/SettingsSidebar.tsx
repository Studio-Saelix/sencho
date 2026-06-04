import { Search } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { SETTINGS_GROUPS, SETTINGS_ITEMS, isItemVisible, isItemLocked } from './registry';
import type { VisibilityContext, SettingsItemMeta } from './registry';
import type { SectionId } from './types';
import { cn } from '@/lib/utils';

interface SettingsSidebarProps {
    currentSection: SectionId;
    onSectionChange: (section: SectionId) => void;
    dirtyFlags?: Partial<Record<SectionId, boolean>>;
    onOpenPalette: () => void;
}

export function SettingsSidebar({ currentSection, onSectionChange, dirtyFlags, onOpenPalette }: SettingsSidebarProps) {
    const { isAdmin, permissions } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();

    const isAdmiral = permissions?.isAdmiral ?? false;
    const isRemote = activeNode?.type === 'remote';

    const visibility: VisibilityContext = {
        isAdmin,
        isPaid,
        isAdmiral,
        isRemote,
    };

    // An item appears in the sidebar only if its registry visibility predicate
    // passes AND the operator has the entitlement for it. Tier-locked items
    // are hidden entirely from operators who do not qualify so the Community
    // surface stays uncluttered. Backend tier guards remain authoritative.
    function isReachable(item: SettingsItemMeta): boolean {
        return isItemVisible(item, visibility) && !isItemLocked(item, visibility);
    }

    return (
        <aside className="w-[240px] rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors flex flex-col shrink-0 min-h-0 overflow-hidden">
            <div className="px-3 pt-5 pb-2">
                <button
                    onClick={onOpenPalette}
                    className="flex w-full items-center gap-2 rounded-md border border-glass-border bg-glass px-2.5 py-1.5 text-xs text-stat-subtitle transition-colors hover:border-brand/30 hover:text-stat-value"
                >
                    <Search className="h-3 w-3 shrink-0" />
                    <span className="flex-1 text-left">Filter</span>
                    <kbd className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle/70 border border-card-border rounded px-1 py-px">
                        ⌘K
                    </kbd>
                </button>
            </div>

            <ScrollArea className="flex-1 px-3">
                <nav className="pb-4">
                    {SETTINGS_GROUPS.map(group => {
                        const groupItems = SETTINGS_ITEMS.filter(
                            item => item.group === group.id && isReachable(item),
                        );

                        if (groupItems.length === 0) return null;

                        return (
                            <div key={group.id} className="mb-1 mt-3">
                                <div className="mb-1 flex items-center justify-between gap-2 px-2">
                                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle/70">
                                        {group.label}
                                    </span>
                                    <span className="font-mono text-[10px] leading-3 tabular-nums text-stat-subtitle/50">
                                        {groupItems.length}
                                    </span>
                                </div>
                                {groupItems.map(item => {
                                    const isDirty = dirtyFlags?.[item.id] ?? false;
                                    const isActive = item.id === currentSection;

                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => onSectionChange(item.id)}
                                            aria-current={isActive ? 'page' : undefined}
                                            className={cn(
                                                'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                                                isActive
                                                    ? 'text-stat-value'
                                                    : 'text-stat-subtitle hover:bg-accent/40 hover:text-stat-value',
                                            )}
                                        >
                                            {isActive && (
                                                <span
                                                    aria-hidden="true"
                                                    className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-brand shadow-[0_0_8px_color-mix(in_oklch,var(--brand)_30%,transparent)]"
                                                />
                                            )}
                                            <span
                                                aria-hidden="true"
                                                className={cn(
                                                    'h-1 w-1 shrink-0 rounded-full',
                                                    isActive ? 'bg-brand' : 'bg-stat-subtitle/40',
                                                )}
                                            />
                                            <span className="flex-1 truncate text-left">{item.label}</span>
                                            {isDirty && (
                                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                </nav>
            </ScrollArea>
        </aside>
    );
}
