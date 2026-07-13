import { useLicense } from '@/context/LicenseContext';
import { TierBadge } from '@/components/TierBadge';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';

const SOURCE_URL = 'https://github.com/studio-saelix/sencho';
const LICENSE_URL = 'https://github.com/studio-saelix/sencho/blob/main/LICENSE';
const LICENSING_DOCS_URL = 'https://docs.sencho.io/features/licensing';
const CHANGELOG_URL = 'https://github.com/studio-saelix/sencho/blob/main/CHANGELOG.md';

const linkClassName =
    'font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-brand hover:text-brand/80 transition-colors';

export function AboutSection() {
    const { license } = useLicense();

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

export const ABOUT_LINK_URLS = {
    source: SOURCE_URL,
    license: LICENSE_URL,
    licensingDocs: LICENSING_DOCS_URL,
    changelog: CHANGELOG_URL,
} as const;
