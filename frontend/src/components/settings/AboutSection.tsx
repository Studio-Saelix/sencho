import { useState } from 'react';
import { useLicense } from '@/context/LicenseContext';
import { useBuildInfo } from '@/hooks/useBuildInfo';
import { TierBadge } from '@/components/TierBadge';
import { Badge } from '@/components/ui/badge';
import { FlaskConical } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard';
import { TogglePill } from '@/components/ui/toggle-pill';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';
import { whatsNewEntries } from '@/whats-new/entries';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import {
    SOURCE_URL,
    LICENSE_URL,
    LICENSING_DOCS_URL,
    CHANGELOG_URL,
} from './aboutLinks';

const linkClassName =
    'font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-brand hover:text-brand/80 transition-colors';

const mono = 'font-mono text-sm text-stat-value';

function BuildChannelChip({ label }: { label: string }) {
    if (label === 'Dev') {
        return (
            <Badge className="text-[10px] px-1.5 py-0 h-4 bg-warning/15 text-warning border-warning/30 shrink-0">
                <FlaskConical className="w-2.5 h-2.5 mr-0.5" strokeWidth={1.5} /> Dev
            </Badge>
        );
    }
    if (label === 'Preview') {
        return (
            <Badge className="text-[10px] px-1.5 py-0 h-4 bg-brand/15 text-brand border-brand/30 shrink-0">
                Preview
            </Badge>
        );
    }
    return <span className={mono}>{label}</span>;
}

export function AboutSection() {
    const { license } = useLicense();
    const { buildInfo, status } = useBuildInfo();
    const { enabled: whatsNewEnabled, setEnabled: setWhatsNewEnabled } = useWhatsNewPreference();
    const [copied, setCopied] = useState(false);

    // Loading surfaces a placeholder and error surfaces "Unknown" (truthful);
    // the reference and revision fields below read "Restricted" for a redacted
    // hardened image, before their null-check.
    const channelLabel = (() => {
        if (status === 'loading') return '…';
        if (status === 'error' || !buildInfo) return 'Unknown';
        switch (buildInfo.channel) {
            case 'dev': return 'Dev';
            case 'preview': return 'Preview';
            case 'stable': return 'Stable';
            default: return 'Unknown';
        }
    })();
    const resolveLabel = (value: string | null | undefined) =>
        buildInfo?.restricted
            ? 'Restricted'
            : status === 'loading'
                ? '…'
                : status === 'error'
                    ? 'Unknown'
                    : value ?? 'Unknown';

    const imageRefLabel = resolveLabel(buildInfo?.imageRef);
    const revisionLabel = resolveLabel(buildInfo?.revision);
    const imageIdLabel =
        status === 'loading' ? '…'
        : status === 'error' || !buildInfo?.imageId ? 'Unknown'
        : `sha256:${buildInfo.imageId.slice(0, 12)}`;

    const copyImageId = async () => {
        if (!buildInfo?.imageId) return;
        await copyToClipboard(`sha256:${buildInfo.imageId}`);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Build">
                <SettingsField label="Version">
                    <span className={mono}>v{buildInfo?.version ?? __APP_VERSION__}</span>
                </SettingsField>
                <SettingsField
                    label="Channel"
                    helper="The build track this control plane instance is running."
                >
                    <BuildChannelChip label={channelLabel} />
                </SettingsField>
                <SettingsField
                    label="Current image"
                    helper="The image this control plane was started with. A compose edit changes the configured target until the container is recreated."
                >
                    <span className={mono}>{imageRefLabel}</span>
                </SettingsField>
                <SettingsField
                    label="Revision"
                    helper="The immutable digest or pinned dev commit this build resolves to."
                >
                    <span className={mono}>{revisionLabel}</span>
                </SettingsField>
                {imageIdLabel !== 'Unknown' && imageIdLabel !== '…' ? (
                    <SettingsField
                        label="Image ID"
                        helper="The sha256 identifier of the running image. Click to copy the full id."
                    >
                        <button
                            type="button"
                            onClick={() => void copyImageId()}
                            className="text-xs font-mono bg-muted px-2 py-1 rounded cursor-pointer text-stat-value hover:text-brand transition-colors"
                        >
                            {copied ? 'Copied' : imageIdLabel}
                        </button>
                    </SettingsField>
                ) : null}
                <SettingsField label="Tier">
                    <TierBadge />
                </SettingsField>
                <SettingsField label="Plan status">
                    <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-value">
                        {license?.status ?? 'community'}
                    </span>
                </SettingsField>
                {license?.instanceId ? (
                    <SettingsField
                        label="Instance ID"
                        helper="Used to identify this control plane to the license server."
                    >
                        <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                            {license.instanceId.slice(0, 8)}
                        </code>
                    </SettingsField>
                ) : null}
            </SettingsSection>

            {/* Hidden until an entry exists, matching the nav trigger: the toggle
                would otherwise control an icon that cannot appear. */}
            {whatsNewEntries.length > 0 && (
                <SettingsSection title="Preferences">
                    <SettingsField
                        label="Show What's New"
                        helper="Highlight the sparkle icon in the top bar when a new feature ships."
                    >
                        <TogglePill
                            id="whats-new-enabled"
                            // Visible text is only ON/OFF, so the setting needs a name.
                            aria-label="Show What's New"
                            checked={whatsNewEnabled}
                            onChange={setWhatsNewEnabled}
                        />
                    </SettingsField>
                </SettingsSection>
            )}

            <SettingsSection title="Links">
                <SettingsField
                    label="Source code"
                    helper="Browse the AGPLv3 repository on GitHub."
                >
                    <a
                        href={SOURCE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClassName}
                    >
                        github.com/studio-saelix/sencho →
                    </a>
                </SettingsField>
                <SettingsField
                    label="AGPLv3 License"
                    helper="Copyright (c) 2026 Studio Saelix. Full license text."
                >
                    <a
                        href={LICENSE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClassName}
                    >
                        LICENSE →
                    </a>
                </SettingsField>
                <SettingsField
                    label="Licensing documentation"
                    helper="Community and Admiral plans."
                >
                    <a
                        href={LICENSING_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClassName}
                    >
                        docs.sencho.io/features/licensing →
                    </a>
                </SettingsField>
                <SettingsField
                    label="Changelog"
                    helper="See what shipped, when, and why."
                >
                    <a
                        href={CHANGELOG_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClassName}
                    >
                        CHANGELOG.md →
                    </a>
                </SettingsField>
            </SettingsSection>
        </div>
    );
}
