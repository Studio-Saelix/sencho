import { useMemo, useState } from 'react';
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

const PRICING_URL = 'https://sencho.io/pricing';

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

    // Pricing link covers two cases: Community-tier operators evaluating
    // a paid plan, and expired paid licensees who need a path back. Active
    // and trial paid licensees already manage their plan through the
    // billing portal in the Plan section above.
    const showPricingLink = !isPaid || license?.status === 'expired';

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
                            ? 'Your license has expired. Renew to restore paid features.'
                            : license?.status === 'disabled'
                                ? 'Your license has been disabled. Contact support for assistance.'
                                : license?.status === 'trial' && license.trialDaysRemaining !== null
                                    ? `Trial: ${license.trialDaysRemaining} day${license.trialDaysRemaining !== 1 ? 's' : ''} remaining.`
                                    : isPaid
                                        ? 'Active license on this control plane.'
                                        : 'Free tier with the core experience.'
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
                        helper="Renew to restore paid features."
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
                        helper="Activate before the trial ends to keep paid features."
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
        </div>
    );
}
