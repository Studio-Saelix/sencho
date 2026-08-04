import { useLicense } from '@/context/LicenseContext';
import { TierBadge } from '@/components/TierBadge';
import { TogglePill } from '@/components/ui/toggle-pill';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';
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

export function AboutSection() {
    const { license } = useLicense();
    const { enabled: whatsNewEnabled, setEnabled: setWhatsNewEnabled } = useWhatsNewPreference();

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Build">
                <SettingsField label="Version">
                    <span className="font-mono text-sm text-stat-value">v{__APP_VERSION__}</span>
                </SettingsField>
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

            <SettingsSection title="Preferences">
                <SettingsField
                    label="Show What's New"
                    helper="Breathe the sparkle icon in the nav bar when a feature you have not seen yet ships."
                >
                    <TogglePill
                        id="whats-new-enabled"
                        checked={whatsNewEnabled}
                        onChange={setWhatsNewEnabled}
                    />
                </SettingsField>
            </SettingsSection>

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
