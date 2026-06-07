import { lazy, Suspense, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
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
    getSettingsItem,
} from './index';
import type { SectionId } from './index';
import LazyBoundary from '../LazyBoundary';
import { SectionGate } from './SectionGate';

// Paid-tier sections are loaded on demand. SectionGate returns null for
// Community / unentitled operators before reaching the JSX that would mount
// these components, so the chunks are never fetched on those installs and the
// JSX, copy, and prop shapes never enter the bundle a Community user downloads.
// Bypassing the ./index barrel keeps each component in its own chunk; importing
// through the barrel would pull every named export into the same chunk and
// defeat the split.
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
// section's chunk request and its first render. SectionGate returns null for
// locked tiers and never mounts the lazy children, so this never flashes for them.
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

function renderSection(
    sectionId: SectionId,
    isPaid: boolean,
    onDirtyChange: (section: SectionId, dirty: boolean) => void,
) {
    switch (sectionId) {
        case 'account': return <AccountSection />;
        case 'appearance': return <AppearanceSection />;
        case 'license': return <LicenseSection />;
        case 'users': return <UsersSection />;
        case 'sso': return <SSOSection />;
        case 'api-tokens': return <ApiTokensSection />;
        case 'registries': return <RegistriesSection />;
        case 'labels': return <LabelsSection />;
        case 'host-alerts': return <HostAlertsSection onDirtyChange={(d) => onDirtyChange('host-alerts', d)} />;
        case 'docker-storage': return <DockerStorageSection onDirtyChange={(d) => onDirtyChange('docker-storage', d)} />;
        case 'fleet-mesh': return <FleetMeshSection onDirtyChange={(d) => onDirtyChange('fleet-mesh', d)} />;
        case 'notifications': return <NotificationsSection />;
        case 'notification-routing': return <NotificationRoutingSection />;
        case 'webhooks': return <WebhooksSection />;
        case 'security': return <SecuritySection isPaid={isPaid} />;
        case 'cloud-backup': return <CloudBackupSection />;
        case 'developer': return <DeveloperSection onDirtyChange={(d) => onDirtyChange('developer', d)} />;
        case 'data-retention': return <DataRetentionSection onDirtyChange={(d) => onDirtyChange('data-retention', d)} />;
        case 'nodes': return <NodeManager />;
        case 'app-store': return <AppStoreSection />;
        case 'recovery': return <RecoverySection />;
        case 'support': return <SupportSection />;
        case 'about': return <AboutSection />;
        // Exhaustiveness guard: a new SectionId without a case above fails tsc here.
        default: return assertExhaustiveSection(sectionId);
    }
}

interface SettingsSectionContentProps {
    sectionId: SectionId;
    isPaid: boolean;
    onDirtyChange: (section: SectionId, dirty: boolean) => void;
    /** Render the section's lead description paragraph above the content. */
    showDescription?: boolean;
}

/**
 * Renders a single settings section: its optional description, then the section
 * component behind the tier gate and a lazy-chunk Suspense boundary. Shared by
 * the desktop SettingsPage and the mobile settings screen so the section switch,
 * lazy splitting, and gating live in exactly one place.
 */
export function SettingsSectionContent({ sectionId, isPaid, onDirtyChange, showDescription }: SettingsSectionContentProps) {
    const item = getSettingsItem(sectionId);
    // Memoize the section element so unrelated re-renders of the host page (the
    // command palette opening, a dirty-flag toggle) do not re-render the active
    // section. onDirtyChange is stable from both call sites.
    const element = useMemo(
        () => renderSection(sectionId, isPaid, onDirtyChange),
        [sectionId, isPaid, onDirtyChange],
    );
    return (
        <>
            {showDescription && item?.description ? (
                <p className="text-sm text-stat-subtitle/90 leading-relaxed max-w-3xl">
                    {item.description}
                </p>
            ) : null}
            {/* Suspense outside SectionGate so the locked-tier path (which never
                mounts the lazy children) does not see a fallback flash.
                LazyBoundary outside Suspense catches chunk-fetch failures so a
                tab left open across a deploy shows a Reload card instead of
                crashing the workspace. */}
            <LazyBoundary>
                <Suspense fallback={<SectionSkeleton />}>
                    <SectionGate sectionId={sectionId}>
                        {element}
                    </SectionGate>
                </Suspense>
            </LazyBoundary>
        </>
    );
}

// Compile-time check that the section switch covers every SectionId. If the
// switch is ever reached at runtime (it should not be, since the section id is a
// validated registry id), log the unhandled id and render nothing rather than crash.
function assertExhaustiveSection(section: never): null {
    console.error('Unhandled settings section', section);
    return null;
}
