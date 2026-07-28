import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast-store';
import { useLicense } from '@/context/LicenseContext';
import { TierBadge } from '@/components/TierBadge';
import {
    Crown, CheckCircle, XCircle, Clock, ExternalLink,
    CreditCard, RefreshCw, Loader2,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { ConfirmModal } from '@/components/ui/modal';

const PRICING_URL = 'https://sencho.io/pricing';
const SOURCE_URL = 'https://github.com/Studio-Saelix/sencho';

type ImageChannel = 'community' | 'hardened' | 'unknown';

interface ImageOperation {
    operationId: string;
    state: 'pending_pull' | 'pulling' | 'patching' | 'recreating' | 'succeeded' | 'failed';
    failureCode?: string;
}

interface ImageChannelStatus {
    channel: ImageChannel;
    composeImageRef?: string;
    operation?: ImageOperation | null;
}

interface HardenedPreflight {
    preflightFingerprint: string;
    currentImageRef: string;
    allowedImageRef: string;
    composeFilePath: string;
    pinKind: string;
    localRegistryAccess: string;
}

function formatChannel(channel: ImageChannel): string {
    switch (channel) {
        case 'community':
            return 'Community';
        case 'hardened':
            return 'Hardened';
        default:
            return 'Custom';
    }
}

function getTierDisplayName(tier?: string, status?: string): string {
    if (tier === 'paid' && status === 'trial') return 'Sencho Admiral (Trial)';
    if (tier === 'paid') return 'Sencho Admiral';
    return 'Sencho Community';
}

function getTierMastheadValue(tier?: string): string {
    return tier === 'paid' ? 'admiral' : 'community';
}

export function LicenseSection() {
    const { license, isPaid, activate, deactivate } = useLicense();
    const [licenseKeyInput, setLicenseKeyInput] = useState('');
    const [isActivating, setIsActivating] = useState(false);
    const [isDeactivating, setIsDeactivating] = useState(false);
    const [billingLoading, setBillingLoading] = useState(false);
    const [channelStatus, setChannelStatus] = useState<ImageChannelStatus | null>(null);
    const [acknowledging, setAcknowledging] = useState(false);
    const [preflight, setPreflight] = useState<HardenedPreflight | null>(null);
    const [preflightLoading, setPreflightLoading] = useState(false);
    const [switching, setSwitching] = useState(false);

    const loadImageChannel = useCallback(async () => {
        try {
            const res = await apiFetch('/license/image-channel/status', { localOnly: true });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Unable to load image channel status.');
            setChannelStatus(data as ImageChannelStatus);
        } catch (error) {
            toast.error((error as Error)?.message || 'Unable to load image channel status.');
        }
    }, []);

    useEffect(() => {
        void loadImageChannel();
    }, [loadImageChannel]);

    const acknowledgeOperation = async () => {
        const operation = channelStatus?.operation;
        if (!operation || operation.state !== 'failed') return;
        setAcknowledging(true);
        try {
            const res = await apiFetch(`/license/image-channel/operations/${operation.operationId}/acknowledge`, {
                method: 'POST',
                localOnly: true,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || 'Unable to acknowledge the failed operation.');
            }
            toast.success('Failed image operation acknowledged.');
            await loadImageChannel();
        } catch (error) {
            toast.error((error as Error)?.message || 'Unable to acknowledge the failed operation.');
        } finally {
            setAcknowledging(false);
        }
    };

    const openPreflight = async () => {
        setPreflightLoading(true);
        try {
            const res = await apiFetch('/license/image-channel/preflight', { method: 'POST', localOnly: true });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Hardened Build access is unavailable.');
            setPreflight(data as HardenedPreflight);
        } catch (error) {
            toast.error((error as Error)?.message || 'Hardened Build access is unavailable.');
        } finally {
            setPreflightLoading(false);
        }
    };

    const switchToHardened = async () => {
        if (!preflight) return;
        setSwitching(true);
        try {
            const res = await apiFetch('/license/image-channel/switch', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ preflightFingerprint: preflight.preflightFingerprint }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Image channel switch could not start.');
            toast.success('Hardened Build switch initiated.');
            setPreflight(null);
            await loadImageChannel();
        } catch (error) {
            toast.error((error as Error)?.message || 'Image channel switch could not start.');
        } finally {
            setSwitching(false);
        }
    };

    const openBillingPortal = async () => {
        setBillingLoading(true);
        try {
            const res = await apiFetch('/license/billing-portal', { localOnly: true });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.url) {
                window.open(data.url, '_blank');
                return;
            }
            toast.error(data?.error || data?.message || data?.data?.error || 'Something went wrong.');
        } catch {
            toast.error('Failed to open billing portal.');
        } finally {
            setBillingLoading(false);
        }
    };

    // Pricing link is only for expired paid licensees who need a path back
    // to renew. Community tier gets no upsell; active and trial paid
    // licensees already manage their plan through the billing portal above.
    const showPricingLink = license?.status === 'expired';

    const renewsValue = useMemo(() => {
        if (!license) return null;
        if (license.isLifetime) return 'lifetime';
        if (license.validUntil) return new Date(license.validUntil).toLocaleDateString();
        return null;
    }, [license]);

    useMastheadStats([
        {
            label: 'PLAN',
            value: getTierMastheadValue(license?.tier),
            tone: isPaid ? 'value' : 'subtitle',
        },
        ...(license?.status === 'trial' && license.trialDaysRemaining !== null
            ? [{
                label: 'TRIAL',
                value: `${license.trialDaysRemaining}d left`,
                tone: 'warn' as const,
            }]
            : []),
        ...(license?.status === 'active' && renewsValue
            ? [{ label: license.isLifetime ? 'DURATION' : 'RENEWS', value: renewsValue }]
            : []),
        ...(license?.status === 'expired'
            ? [{ label: 'STATUS', value: 'expired', tone: 'error' as const }]
            : []),
    ]);

    const tierIcon = isPaid ? <CheckCircle className="h-4 w-4" /> : <Crown className="h-4 w-4" />;

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Plan">
                <SettingsField
                    label={getTierDisplayName(license?.tier, license?.status)}
                    helper={
                        license?.status === 'expired'
                            ? 'Your Admiral license has expired. Renew to restore Admiral assurance (priority support, Recovery Vault, Hardened Build, and governance).'
                            : license?.status === 'disabled'
                                ? 'Your license has been disabled. Contact support for assistance.'
                                : license?.status === 'trial' && license.trialDaysRemaining !== null
                                    ? `Trial: ${license.trialDaysRemaining} day${license.trialDaysRemaining !== 1 ? 's' : ''} remaining.`
                                    : isPaid
                                        ? 'Active license on this control plane.'
                                        : 'Community plan. Full AGPLv3 self-hosted control plane.'
                    }
                    tone={
                        license?.status === 'expired' || license?.status === 'disabled'
                            ? 'error'
                            : license?.status === 'trial'
                                ? 'warn'
                                : 'default'
                    }
                >
                    <div className="flex items-center gap-2">
                        <span className="text-stat-subtitle">{tierIcon}</span>
                        <TierBadge />
                    </div>
                </SettingsField>

                {!isPaid ? (
                    <SettingsField label="License" helper="Sencho Community is released under AGPLv3.">
                        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
                            View source
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                    </SettingsField>
                ) : (
                    <SettingsField label="Recovery Vault" helper="Your Admiral subscription includes Recovery Vault entitlement.">
                        <span className="inline-flex items-center gap-2 text-sm text-success">
                            <CheckCircle className="h-4 w-4" />
                            Included
                        </span>
                    </SettingsField>
                )}
                {isPaid && channelStatus?.channel !== 'hardened' ? (
                    <SettingsField label="Hardened Build" helper="Review entitlement and registry access before changing image channels.">
                        <SettingsPrimaryButton size="sm" onClick={openPreflight} disabled={preflightLoading}>
                            {preflightLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            Switch to Hardened
                        </SettingsPrimaryButton>
                    </SettingsField>
                ) : null}
                <SettingsField
                    label="Current image"
                    helper={channelStatus?.channel === 'hardened' && !channelStatus.composeImageRef
                        ? 'Hardened image details are available to administrators only.'
                        : 'Current image channel for this control plane.'}
                >
                    <span className="font-mono text-xs text-stat-value break-all">
                        {channelStatus?.composeImageRef ?? formatChannel(channelStatus?.channel ?? 'unknown')}
                    </span>
                </SettingsField>
                <SettingsField label="Channel">
                    <span className="text-sm text-stat-value">{formatChannel(channelStatus?.channel ?? 'unknown')}</span>
                </SettingsField>
                {channelStatus?.operation?.state === 'failed' ? (
                    <SettingsField
                        label="Image operation"
                        helper={channelStatus.operation.failureCode || 'The image operation failed before completion.'}
                        tone="error"
                    >
                        <Button variant="outline" size="sm" onClick={acknowledgeOperation} disabled={acknowledging}>
                            {acknowledging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            Acknowledge failure
                        </Button>
                    </SettingsField>
                ) : null}

                {license?.status === 'active' && license.customerName ? (
                    <SettingsField label="Customer">
                        <span className="text-sm text-stat-value">{license.customerName}</span>
                    </SettingsField>
                ) : null}

                {license?.status === 'active' && license.productName ? (
                    <SettingsField label="Product">
                        <span className="text-sm text-stat-value">{license.productName}</span>
                    </SettingsField>
                ) : null}

                {license?.status === 'active' && license.maskedKey ? (
                    <SettingsField label="License key">
                        <span className="font-mono text-xs text-stat-value">{license.maskedKey}</span>
                    </SettingsField>
                ) : null}

                {license?.status === 'expired' ? (
                    <SettingsField
                        label="Status"
                        helper="Renew to restore Admiral assurance (priority support, Recovery Vault, Hardened Build, and governance)."
                        tone="error"
                    >
                        <div className="flex items-center gap-2 text-destructive">
                            <XCircle className="h-4 w-4" />
                            <span className="text-sm">Expired</span>
                        </div>
                    </SettingsField>
                ) : null}

                {license?.status === 'trial' && license.trialDaysRemaining !== null ? (
                    <SettingsField
                        label="Trial countdown"
                        helper="Activate before the trial ends to keep Admiral assurance (priority support, Recovery Vault, Hardened Build, and governance)."
                        tone="warn"
                    >
                        <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-warning" />
                            <span className="font-mono tabular-nums text-sm text-stat-value">
                                {license.trialDaysRemaining} day{license.trialDaysRemaining !== 1 ? 's' : ''}
                            </span>
                        </div>
                    </SettingsField>
                ) : null}

                {license?.status === 'active' ? (
                    <SettingsActions align="between" hint="Lemon Squeezy manages billing">
                        <div className="flex items-center gap-2">
                            {!license.isLifetime && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={openBillingPortal}
                                    disabled={billingLoading}
                                >
                                    {billingLoading ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <CreditCard className="w-4 h-4" />
                                    )}
                                    Manage subscription
                                    <ExternalLink className="w-3 h-3 opacity-50" />
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={async () => {
                                    setIsDeactivating(true);
                                    const result = await deactivate();
                                    if (result.success) {
                                        toast.success('License deactivated.');
                                    } else {
                                        toast.error(result.error || 'Deactivation failed');
                                    }
                                    setIsDeactivating(false);
                                }}
                                disabled={isDeactivating}
                            >
                                {isDeactivating ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                        Deactivating
                                    </>
                                ) : (
                                    'Deactivate'
                                )}
                            </Button>
                        </div>
                    </SettingsActions>
                ) : null}
            </SettingsSection>

            {license?.status !== 'active' ? (
                <SettingsSection title="Activate">
                    <SettingsField
                        label="License key"
                        helper="Paste the key from your activation email."
                        htmlFor="license-key"
                    >
                        <div className="flex gap-2">
                            <Input
                                id="license-key"
                                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                                value={licenseKeyInput}
                                onChange={(e) => setLicenseKeyInput(e.target.value)}
                                className="font-mono"
                            />
                            <SettingsPrimaryButton
                                onClick={async () => {
                                    if (!licenseKeyInput.trim()) return;
                                    setIsActivating(true);
                                    const result = await activate(licenseKeyInput.trim());
                                    if (result.success) {
                                        toast.success('License activated successfully.');
                                        setLicenseKeyInput('');
                                    } else {
                                        toast.error(result.error || 'Activation failed');
                                    }
                                    setIsActivating(false);
                                }}
                                disabled={isActivating || !licenseKeyInput.trim()}
                            >
                                {isActivating ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                        Activating
                                    </>
                                ) : (
                                    'Activate'
                                )}
                            </SettingsPrimaryButton>
                        </div>
                    </SettingsField>
                </SettingsSection>
            ) : null}

            {showPricingLink ? (
                <SettingsSection title="Pricing">
                    <div className="pt-[var(--density-row-y,0.75rem)]">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(PRICING_URL, '_blank')}
                        >
                            See pricing
                            <ExternalLink className="w-3 h-3 opacity-60" />
                        </Button>
                    </div>
                </SettingsSection>
            ) : null}
            <ConfirmModal
                open={preflight !== null}
                onOpenChange={(open) => !open && setPreflight(null)}
                kicker="ADMIRAL ACCOUNT · HARDENED BUILD"
                title="Review image switch"
                confirmLabel={switching ? 'Switching' : 'Confirm switch'}
                confirming={switching}
                onConfirm={switchToHardened}
                hint="BACK UP FIRST"
            >
                <div className="space-y-3 text-sm">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-xs">
                        <dt className="text-stat-subtitle">CURRENT</dt><dd className="break-all text-stat-value">{preflight?.currentImageRef}</dd>
                        <dt className="text-stat-subtitle">TARGET</dt><dd className="break-all text-stat-value">{preflight?.allowedImageRef}</dd>
                        <dt className="text-stat-subtitle">REGISTRY</dt><dd className="text-stat-value">{preflight?.localRegistryAccess}</dd>
                        <dt className="text-stat-subtitle">COMPOSE PATH</dt><dd className="break-all text-stat-value">{preflight?.composeFilePath}</dd>
                        <dt className="text-stat-subtitle">PIN KIND</dt><dd className="text-stat-value">{preflight?.pinKind}</dd>
                    </dl>
                    <p className="text-stat-subtitle">Create a backup first. To roll back, restore the prior image reference in the compose file and recreate the service.</p>
                </div>
            </ConfirmModal>
        </div>
    );
}
