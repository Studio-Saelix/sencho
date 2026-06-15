import { useLayoutEffect, useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import {
    SETTINGS_ITEMS,
    SETTINGS_GROUPS,
    getSettingsItem,
    getSettingsGroup,
    isItemVisible,
    isItemLocked,
    scopeLabel,
} from './index';
import type { SectionId, SettingsItemMeta, VisibilityContext } from './index';
import { SettingsSidebar } from './SettingsSidebar';
import { SettingsSectionContent } from './SettingsSectionContent';
import { MastheadStatsProvider, useMastheadStatsValue } from './MastheadStatsContext';

interface SettingsPageProps {
    currentSection: SectionId;
    onSectionChange: (section: SectionId) => void;
}

export function SettingsPage(props: SettingsPageProps) {
    return (
        <MastheadStatsProvider>
            <SettingsPageInner {...props} />
        </MastheadStatsProvider>
    );
}

function SettingsPageInner({ currentSection, onSectionChange }: SettingsPageProps) {
    const { isAdmin } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();
    const isRemote = activeNode?.type === 'remote';

    // Mobile master/detail: below md the nav rail and the section content cannot
    // sit side by side, so the rail is a full-screen list and choosing a section
    // pushes it full-screen with a back affordance. Desktop shows both as before.
    const isMobile = useIsMobile();
    const [mobileSectionOpen, setMobileSectionOpen] = useState(false);
    const handleSectionChange = useCallback((section: SectionId) => {
        onSectionChange(section);
        if (isMobile) setMobileSectionOpen(true);
    }, [onSectionChange, isMobile]);
    // Desktop shows both panes; mobile shows exactly one (the rail or the section).
    const showSidebar = !isMobile || !mobileSectionOpen;
    const showSection = !isMobile || mobileSectionOpen;
    const visibility: VisibilityContext = useMemo(
        () => ({ isRemote, isAdmin, isPaid }),
        [isRemote, isAdmin, isPaid],
    );

    // Resolve the rendered section: must be a registry id and must be visible to the
    // current operator. If the current selection points to a hidden section (e.g.,
    // node-scoped item on a remote, or admin-only item for a non-admin), fall back to
    // the first visible item.
    const safeSection: SectionId = useMemo(() => {
        const reachable = (i: SettingsItemMeta) => isItemVisible(i, visibility) && !isItemLocked(i, visibility);
        const direct = SETTINGS_ITEMS.find(i => i.id === currentSection);
        if (direct && reachable(direct)) return direct.id;
        const fallback = SETTINGS_ITEMS.find(reachable);
        return fallback?.id ?? 'appearance';
    }, [currentSection, visibility]);
    useEffect(() => {
        if (safeSection !== currentSection) onSectionChange(safeSection);
    }, [safeSection, currentSection, onSectionChange]);

    const contentViewportRef = useRef<HTMLDivElement | null>(null);
    // Map avoids prototype pollution: Map.set() does not write to object prototype chain.
    const scrollPositionsRef = useRef(new Map<SectionId, number>());

    const [commandOpen, setCommandOpen] = useState(false);
    const [dirtyFlags, setDirtyFlags] = useState<Partial<Record<SectionId, boolean>>>({});

    const handleDirtyChange = useCallback((section: SectionId, dirty: boolean) => {
        setDirtyFlags(prev => {
            if (prev[section] === dirty) return prev;
            return { ...prev, [section]: dirty };
        });
    }, []);

    useLayoutEffect(() => {
        if (contentViewportRef.current) {
            contentViewportRef.current.scrollTop = scrollPositionsRef.current.get(safeSection) ?? 0;
        }
    }, [safeSection]);

    const saveScrollPosition = useCallback(() => {
        if (contentViewportRef.current) {
            scrollPositionsRef.current.set(safeSection, contentViewportRef.current.scrollTop);
        }
    }, [safeSection]);

    const activeItem = getSettingsItem(safeSection);
    const activeGroup = activeItem ? getSettingsGroup(activeItem.group) : undefined;
    const nodeName = activeNode?.name ?? 'local';

    // Items reachable in this session: visible AND not tier-locked. Tier-locked
    // items are hidden entirely from operators who do not qualify so the
    // command palette and the sidebar never surface unreachable destinations.
    const visibleItems = useMemo(
        () => SETTINGS_ITEMS.filter(item =>
            isItemVisible(item, visibility) && !isItemLocked(item, visibility),
        ),
        [visibility],
    );

    const visibleGroups = useMemo(() =>
        SETTINGS_GROUPS
            .map(group => ({
                ...group,
                items: visibleItems.filter(item => item.group === group.id),
            }))
            .filter(group => group.items.length > 0),
        [visibleItems],
    );

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            setCommandOpen(open => !open);
        }
    }, []);

    const kicker = activeItem && activeGroup
        ? `Settings · ${activeGroup.label} · ${activeItem.label}`
        : 'Settings';

    const extraStats = useMastheadStatsValue();
    const metadata = useMemo<MastheadMetadataItem[]>(() => {
        const baseScope: MastheadMetadataItem = activeItem
            ? activeItem.scope === 'node'
                ? { label: 'NODE', value: nodeName }
                : { label: 'SCOPE', value: scopeLabel(activeItem) }
            : { label: 'SCOPE', value: 'global' };
        return [baseScope, ...(extraStats ?? [])];
    }, [activeItem, nodeName, extraStats]);

    return (
        <div
            className="h-full overflow-auto p-6 flex flex-col gap-4 min-w-0"
            onKeyDown={handleKeyDown}
        >
            <PageMasthead
                kicker={kicker}
                state={activeItem?.label ?? 'Settings'}
                tone="live"
                pulsing={false}
                metadata={metadata}
                className="rounded-lg"
            />

            <div className="flex flex-1 min-h-0 gap-4">
                {showSidebar && (
                    <SettingsSidebar
                        dirtyFlags={dirtyFlags}
                        currentSection={safeSection}
                        onSectionChange={handleSectionChange}
                        onOpenPalette={() => setCommandOpen(true)}
                    />
                )}

                {showSection && (
                <div className="flex-1 min-h-0 min-w-0 rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors overflow-hidden flex flex-col">
                    {isMobile && mobileSectionOpen && (
                        <button
                            type="button"
                            onClick={() => setMobileSectionOpen(false)}
                            className="md:hidden flex shrink-0 items-center gap-1 border-b border-hairline px-4 py-3 font-mono text-xs text-brand"
                        >
                            <ChevronLeft className="h-4 w-4" strokeWidth={1.6} />
                            Settings
                        </button>
                    )}
                    <ScrollArea
                        block
                        viewportRef={contentViewportRef}
                        className="flex-1 min-w-0"
                        onScrollCapture={saveScrollPosition}
                    >
                        <div className="px-7 pt-6 pb-8 flex flex-col gap-6 min-w-0">
                            <SettingsSectionContent
                                sectionId={safeSection}
                                onDirtyChange={handleDirtyChange}
                                showDescription
                            />
                        </div>
                    </ScrollArea>
                </div>
                )}
            </div>

            <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
                <CommandInput placeholder="Jump to a setting..." />
                <CommandList>
                    <CommandEmpty>No matching settings.</CommandEmpty>
                    {visibleGroups.map(group => (
                        <CommandGroup key={group.id} heading={group.label}>
                            {group.items.map(item => (
                                <SettingsCommandItem
                                    key={item.id}
                                    item={item}
                                    glyph={group.glyph}
                                    onSelect={() => {
                                        setCommandOpen(false);
                                        handleSectionChange(item.id);
                                    }}
                                />
                            ))}
                        </CommandGroup>
                    ))}
                </CommandList>
            </CommandDialog>
        </div>
    );
}

function SettingsCommandItem({
    item,
    glyph,
    onSelect,
}: {
    item: SettingsItemMeta;
    glyph: string;
    onSelect: () => void;
}) {
    const searchValue = [item.label, item.description, ...item.keywords].join(' ').toLowerCase();
    return (
        <CommandItem value={searchValue} onSelect={onSelect}>
            <span className="font-mono text-[10px] w-3 text-center text-stat-subtitle/70">{glyph}</span>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-sm font-medium text-stat-value truncate">{item.label}</span>
                <span className="text-xs text-stat-subtitle truncate">{item.description}</span>
            </div>
        </CommandItem>
    );
}
