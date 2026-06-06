// Free-tier sections are exported eagerly: every operator sees them on every
// install so static imports keep first-paint fast.
export { AccountSection } from './AccountSection';
export { AppearanceSection } from './AppearanceSection';
export { LicenseSection } from './LicenseSection';
export { HostAlertsSection } from './HostAlertsSection';
export { DockerStorageSection } from './DockerStorageSection';
export { FleetMeshSection } from './FleetMeshSection';
export { NotificationsSection } from './NotificationsSection';
export { DeveloperSection } from './DeveloperSection';
export { DataRetentionSection } from './DataRetentionSection';
export { AppStoreSection } from './AppStoreSection';
export { SupportSection } from './SupportSection';
export { AboutSection } from './AboutSection';
export { RecoverySection } from './RecoverySection';

// Paid-tier sections (UsersSection, WebhooksSection, SecuritySection,
// LabelsSection, CloudBackupSection, NotificationRoutingSection) are NOT
// re-exported from this barrel. They are dynamically imported with
// React.lazy in SettingsPage.tsx so their JSX, copy, and prop shapes do not
// land in the bundle a Community user downloads. Re-adding any of them as a
// static export here would defeat the split: rollup detects the static path
// and keeps the module in the main chunk regardless of the lazy() call.
export { DEFAULT_SETTINGS } from './types';
export type { PatchableSettings, SectionId, Agent } from './types';
export {
    SETTINGS_GROUPS,
    SETTINGS_ITEMS,
    getSettingsItem,
    getSettingsGroup,
    isItemVisible,
    isItemLocked,
} from './registry';
export type {
    SettingsGroupId,
    SettingsGroupMeta,
    SettingsItemMeta,
    TierGate,
    Scope,
    VisibilityContext,
} from './registry';
export { SettingsSection } from './SettingsSection';
export { SettingsField, type SettingsFieldTone } from './SettingsField';
export { SettingsCallout, type SettingsCalloutTone } from './SettingsCallout';
export { SettingsActions, SettingsPrimaryButton, SettingsSecondaryButton } from './SettingsActions';
export { useMastheadStats } from './MastheadStatsContext';
