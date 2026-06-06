import { useLayoutEffect, useRef, useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { NodeManager } from '../NodeManager';
import { SSOSection } from '../SSOSection';
import {
    AccountSection,
    AppearanceSection,
    LicenseSection,
    HostAlertsSection,
    DockerStorageSection,
    FleetMeshSection,
    NotificationsSection,
    DeveloperSection,
    DataRetentionSection,
    AppStoreSection,
    SupportSection,
    AboutSection,
    RecoverySection,
    SETTINGS_ITEMS,
    SETTINGS_GROUPS,
    getSettingsItem,
    getSettingsGroup,
    isItemVisible,
    isItemLocked,
} from './index';
import type { SectionId, SettingsItemMeta, VisibilityContext } from './index';
import LazyBoundary from '../LazyBoundary';
import { SectionGate } from './SectionGate';
import { SettingsSidebar } from './SettingsSidebar';
import { MastheadStatsProvider, useMastheadStatsValue } from './MastheadStatsContext';

// Paid-tier sections are loaded on demand. SectionGate short-circuits to a
// TierLockedCard for Community / wrong-variant operators before reaching the
// JSX that would mount these components, so the chunks are never fetched on
// those installs and the JSX, copy, and prop shapes never enter the bundle a
// Community user downloads. Bypassing the ./index barrel keeps each component
// in its own chunk; importing through the barrel would pull every named
// export into the same chunk and defeat the split.
const UsersSection = lazy(() =>
    import('./UsersSection').then(m => ({ default: m.UsersSection })),
);
const WebhooksSection = lazy(() =>
    import('./WebhooksSection').then(m => ({ default: m.WebhooksSection })),
);
const SecuritySection = lazy(() =>
    import('./SecuritySection').then(m => ({ default: m.SecuritySection })),
);
const LabelsSection = lazy(() =>
    import('./LabelsSection').then(m => ({ default: m.LabelsSection })),
);
const NotificationRoutingSection = lazy(() =>
    import('./NotificationRoutingSection').then(m => ({ default: m.NotificationRoutingSection })),
);
const CloudBackupSection = lazy(() =>
    import('./CloudBackupSection').then(m => ({ default: m.CloudBackupSection })),
);
const ApiTokensSection = lazy(() =>
    import('../ApiTokensSection').then(m => ({ default: m.ApiTokensSection })),
);
const RegistriesSection = lazy(() =>
    import('../RegistriesSection').then(m => ({ default: m.RegistriesSection })),
);

// Approximation of a settings section's first-paint shape: a header strip and
// a couple of field rows. Visible only on the brief window between an unlocked
// section's chunk request and its first render. SectionGate's TierLockedCard
// path never mounts the lazy children, so this never flashes for locked tiers.
function SectionSkeleton() {
    return (
        <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-8 w-1/3 rounded-md" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
        </div>
    );
}

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

    const sectionElement = useMemo(() => {
        switch (safeSection) {
            case 'account': return <AccountSection />;
            case 'appearance': return <AppearanceSection />;
            case 'license': return <LicenseSection />;
            case 'users': return <UsersSection />;
            case 'sso': return <SSOSection />;
            case 'api-tokens': return <ApiTokensSection />;
            case 'registries': return <RegistriesSection />;
            case 'labels': return <LabelsSection />;
            case 'host-alerts': return <HostAlertsSection onDirtyChange={(d) => handleDirtyChange('host-alerts', d)} />;
            case 'docker-storage': return <DockerStorageSection onDirtyChange={(d) => handleDirtyChange('docker-storage', d)} />;
            case 'fleet-mesh': return <FleetMeshSection onDirtyChange={(d) => handleDirtyChange('fleet-mesh', d)} />;
            case 'notifications': return <NotificationsSection />;
            case 'notification-routing': return <NotificationRoutingSection />;
            case 'webhooks': return <WebhooksSection />;
            case 'security': return <SecuritySection isPaid={isPaid} />;
            case 'cloud-backup': return <CloudBackupSection />;
            case 'developer': return <DeveloperSection onDirtyChange={(d) => handleDirtyChange('developer', d)} />;
            case 'data-retention': return <DataRetentionSection onDirtyChange={(d) => handleDirtyChange('data-retention', d)} />;
            case 'nodes': return <NodeManager />;
            case 'app-store': return <AppStoreSection />;
            case 'recovery': return <RecoverySection />;
            case 'support': return <SupportSection />;
            case 'about': return <AboutSection />;
            default: return null;
        }
    // Section components close over isPaid for tier-gated branches; handleDirtyChange is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [safeSection, isPaid]);

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
                <SettingsSidebar
                    dirtyFlags={dirtyFlags}
                    currentSection={safeSection}
                    onSectionChange={onSectionChange}
                    onOpenPalette={() => setCommandOpen(true)}
                />

                <div className="flex-1 min-h-0 min-w-0 rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors overflow-hidden flex flex-col">
                    <ScrollArea
                        block
                        viewportRef={contentViewportRef}
                        className="flex-1 min-w-0"
                        onScrollCapture={saveScrollPosition}
                    >
                        <div className="px-7 pt-6 pb-8 flex flex-col gap-6 min-w-0">
                            {activeItem?.description ? (
                                <p className="text-sm text-stat-subtitle/90 leading-relaxed max-w-3xl">
                                    {activeItem.description}
                                </p>
                            ) : null}
                            {/* Suspense outside SectionGate so the locked-tier
                                path (which never mounts the lazy children)
                                does not see a fallback flash. LazyBoundary
                                outside Suspense catches chunk-fetch failures
                                so a stale tab spans-deploy mismatch shows a
                                Reload card instead of crashing the workspace. */}
                            <LazyBoundary>
                                <Suspense fallback={<SectionSkeleton />}>
                                    <SectionGate sectionId={safeSection}>
                                        {sectionElement}
                                    </SectionGate>
                                </Suspense>
                            </LazyBoundary>
                        </div>
                    </ScrollArea>
                </div>
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
                                        onSectionChange(item.id);
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

function scopeLabel(item: SettingsItemMeta): string {
    if (item.group === 'personal' || item.group === 'access') return 'operator';
    return 'global';
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
