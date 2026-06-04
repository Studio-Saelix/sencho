import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { CapabilityGate } from './CapabilityGate';
import { PaidGate } from './PaidGate';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { SettingsPrimaryButton } from './settings/SettingsActions';
import { useMastheadStats } from './settings/MastheadStatsContext';

const ROLE_OPTIONS = [
    { value: 'viewer', label: 'Viewer' },
    { value: 'admin', label: 'Admin' },
];

interface SSOProviderConfig {
    provider: string;
    enabled: boolean;
    displayName: string;
    // LDAP
    ldapUrl?: string;
    ldapBindDn?: string;
    ldapBindPassword?: string;
    ldapSearchBase?: string;
    ldapSearchFilter?: string;
    ldapAdminGroupDn?: string;
    ldapDefaultRole?: string;
    ldapTlsRejectUnauthorized?: boolean;
    // OIDC
    oidcIssuerUrl?: string;
    oidcClientId?: string;
    oidcClientSecret?: string;
    oidcScopes?: string;
    oidcAdminClaim?: string;
    oidcAdminClaimValue?: string;
    oidcDefaultRole?: string;
    // Custom OIDC claim mapping
    oidcIdClaim?: string;
    oidcUsernameClaim?: string;
    oidcEmailClaim?: string;
}

// Ordered by tier: free OIDC (Custom + presets) first, then LDAP/AD (paid).
// The ordering reinforces the free → paid progression in the UI.
const PROVIDERS = [
    { id: 'oidc_custom', label: 'Custom OIDC', type: 'oidc' as const },
    { id: 'oidc_google', label: 'Google', type: 'oidc' as const },
    { id: 'oidc_github', label: 'GitHub', type: 'oidc' as const },
    { id: 'oidc_okta', label: 'Okta', type: 'oidc' as const },
    { id: 'ldap', label: 'LDAP / Active Directory', type: 'ldap' as const },
];

function ProviderCard({ providerId, type, label, initialConfig, onSave }: {
    providerId: string;
    type: 'ldap' | 'oidc';
    label: string;
    initialConfig: SSOProviderConfig | null;
    onSave: () => void;
}) {
    const [config, setConfig] = useState<Partial<SSOProviderConfig>>(initialConfig || { enabled: false });
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
    const [expanded, setExpanded] = useState(!!initialConfig?.enabled);

    const update = (field: string, value: string | boolean) => {
        setConfig(prev => ({ ...prev, [field]: value }));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const body = {
                ...config,
                provider: providerId,
                displayName: config.displayName || label,
            };
            const res = await apiFetch(`/sso/config/${providerId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                toast.success('SSO configuration saved');
                onSave();
            } else {
                const data = await res.json();
                toast.error(data?.error || data?.message || 'Failed to save');
            }
        } catch (error: unknown) {
            toast.error((error as Error)?.message || 'Failed to save SSO configuration');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const res = await apiFetch(`/sso/config/${providerId}/test`, { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                const message = data?.error || data?.message || 'Connection test failed';
                setTestResult({ success: false, error: message });
                toast.error(message);
                return;
            }
            setTestResult(data);
            if (data?.success) {
                toast.success('Connection successful');
            } else {
                toast.error(data?.error || 'Connection failed');
            }
        } catch (error: unknown) {
            const message = (error as Error)?.message || 'Connection test failed';
            setTestResult({ success: false, error: message });
            toast.error(message);
        } finally {
            setTesting(false);
        }
    };

    const handleDelete = async () => {
        try {
            const res = await apiFetch(`/sso/config/${providerId}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success('SSO provider removed');
                setConfig({ enabled: false });
                setExpanded(false);
                onSave();
            } else {
                const data = await res.json().catch(() => null);
                toast.error(data?.error || data?.message || 'Failed to remove provider');
            }
        } catch (error: unknown) {
            toast.error((error as Error)?.message || 'Failed to remove provider');
        }
    };

    return (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover">
            <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-3">
                    <span className="font-medium text-sm">{label}</span>
                    {initialConfig?.enabled && (
                        <Badge variant="secondary" className="text-xs bg-success-muted text-success border-success/20">
                            Active
                        </Badge>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <TogglePill
                        checked={!!config.enabled}
                        onChange={(checked) => update('enabled', checked)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            </div>

            {expanded && (
                <div className="border-t border-border p-4 space-y-4">
                    {type === 'ldap' ? (
                        <>
                            <div className="grid gap-2">
                                <Label className="text-xs text-muted-foreground">Server URL</Label>
                                <Input
                                    placeholder="ldap://ldap.example.com:389"
                                    value={config.ldapUrl || ''}
                                    onChange={e => update('ldapUrl', e.target.value)}
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Bind DN</Label>
                                    <Input
                                        placeholder="cn=readonly,dc=example,dc=com"
                                        value={config.ldapBindDn || ''}
                                        onChange={e => update('ldapBindDn', e.target.value)}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Bind Password</Label>
                                    <Input
                                        type="password"
                                        placeholder="Enter to update"
                                        value={config.ldapBindPassword || ''}
                                        onChange={e => update('ldapBindPassword', e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-xs text-muted-foreground">Search Base</Label>
                                <Input
                                    placeholder="ou=users,dc=example,dc=com"
                                    value={config.ldapSearchBase || ''}
                                    onChange={e => update('ldapSearchBase', e.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-xs text-muted-foreground">Search Filter</Label>
                                <Input
                                    placeholder="(uid={{username}})"
                                    value={config.ldapSearchFilter || ''}
                                    onChange={e => update('ldapSearchFilter', e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Use <code className="bg-muted px-1 rounded">{'{{username}}'}</code> as placeholder.
                                    For Active Directory: <code className="bg-muted px-1 rounded">{'(sAMAccountName={{username}})'}</code>
                                </p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Admin Group DN</Label>
                                    <Input
                                        placeholder="cn=sencho-admins,ou=groups,dc=..."
                                        value={config.ldapAdminGroupDn || ''}
                                        onChange={e => update('ldapAdminGroupDn', e.target.value)}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Default Role</Label>
                                    <Combobox
                                        options={ROLE_OPTIONS}
                                        value={config.ldapDefaultRole || 'viewer'}
                                        onValueChange={v => update('ldapDefaultRole', v)}
                                        placeholder="Select role"
                                    />
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <TogglePill
                                    checked={config.ldapTlsRejectUnauthorized !== false}
                                    onChange={checked => update('ldapTlsRejectUnauthorized', checked)}
                                />
                                <Label className="text-xs text-muted-foreground">Verify TLS certificate</Label>
                            </div>
                        </>
                    ) : (
                        <>
                            {providerId === 'oidc_custom' && (
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Display Name</Label>
                                    <Input
                                        placeholder="My Identity Provider"
                                        value={config.displayName || ''}
                                        onChange={e => update('displayName', e.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Name shown on the login button (e.g., "Corporate SSO").
                                    </p>
                                </div>
                            )}
                            {(providerId === 'oidc_okta' || providerId === 'oidc_custom') && (
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Issuer URL</Label>
                                    <Input
                                        placeholder={providerId === 'oidc_okta' ? 'https://dev-123456.okta.com' : 'https://auth.example.com/realms/myrealm'}
                                        value={config.oidcIssuerUrl || ''}
                                        onChange={e => update('oidcIssuerUrl', e.target.value)}
                                    />
                                    {providerId === 'oidc_custom' && (
                                        <p className="text-xs text-muted-foreground">
                                            Base URL of the OIDC discovery endpoint (without <code className="bg-muted px-1 rounded">/.well-known/openid-configuration</code>).
                                        </p>
                                    )}
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Client ID</Label>
                                    <Input
                                        placeholder="Client ID"
                                        value={config.oidcClientId || ''}
                                        onChange={e => update('oidcClientId', e.target.value)}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Client Secret</Label>
                                    <Input
                                        type="password"
                                        placeholder="Enter to update"
                                        value={config.oidcClientSecret || ''}
                                        onChange={e => update('oidcClientSecret', e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Admin Claim</Label>
                                    <Input
                                        placeholder="groups"
                                        value={config.oidcAdminClaim || ''}
                                        onChange={e => update('oidcAdminClaim', e.target.value)}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Admin Claim Value</Label>
                                    <Input
                                        placeholder="sencho-admins"
                                        value={config.oidcAdminClaimValue || ''}
                                        onChange={e => update('oidcAdminClaimValue', e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 items-start">
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Scopes</Label>
                                    <Input
                                        placeholder="openid email profile"
                                        value={config.oidcScopes || ''}
                                        onChange={e => update('oidcScopes', e.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Space-separated list of OAuth scopes. Leave blank for default.
                                    </p>
                                </div>
                                <div className="grid gap-2">
                                    <Label className="text-xs text-muted-foreground">Default Role</Label>
                                    <Combobox
                                        options={ROLE_OPTIONS}
                                        value={config.oidcDefaultRole || 'viewer'}
                                        onValueChange={v => update('oidcDefaultRole', v)}
                                        placeholder="Select role"
                                    />
                                </div>
                            </div>
                            {providerId === 'oidc_custom' && (
                                <>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="grid gap-2">
                                            <Label className="text-xs text-muted-foreground">User ID Claim</Label>
                                            <Input
                                                placeholder="sub"
                                                value={config.oidcIdClaim || ''}
                                                onChange={e => update('oidcIdClaim', e.target.value)}
                                            />
                                        </div>
                                        <div className="grid gap-2">
                                            <Label className="text-xs text-muted-foreground">Username Claim</Label>
                                            <Input
                                                placeholder="preferred_username"
                                                value={config.oidcUsernameClaim || ''}
                                                onChange={e => update('oidcUsernameClaim', e.target.value)}
                                            />
                                        </div>
                                        <div className="grid gap-2">
                                            <Label className="text-xs text-muted-foreground">Email Claim</Label>
                                            <Input
                                                placeholder="email"
                                                value={config.oidcEmailClaim || ''}
                                                onChange={e => update('oidcEmailClaim', e.target.value)}
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Map claims from your provider's token to Sencho user fields. Leave blank for standard OIDC defaults.
                                    </p>
                                </>
                            )}
                        </>
                    )}

                    <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center gap-2">
                            <SettingsPrimaryButton size="sm" onClick={handleSave} disabled={saving}>
                                {saving ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving</> : 'Save'}
                            </SettingsPrimaryButton>
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing}>
                                {testing ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Testing...</> : 'Test Connection'}
                            </Button>
                            {testResult && (
                                testResult.success
                                    ? <CheckCircle className="w-4 h-4 text-success" />
                                    : <XCircle className="w-4 h-4 text-destructive" />
                            )}
                        </div>
                        {initialConfig && (
                            <Button size="sm" variant="ghost" className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground" onClick={handleDelete}>
                                Remove
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// Mirrors the backend tier split in ssoConfig.ts requireTierForProvider: Custom OIDC
// and preset OIDC (Google/GitHub/Okta) are free, LDAP/AD requires the paid plan.
function ProviderCardWithGate(props: {
    providerId: string;
    type: 'ldap' | 'oidc';
    label: string;
    initialConfig: SSOProviderConfig | null;
    onSave: () => void;
}) {
    const card = <ProviderCard {...props} />;
    if (props.providerId === 'ldap') {
        return <PaidGate>{card}</PaidGate>;
    }
    return card;
}

export function SSOSection() {
    const [configs, setConfigs] = useState<SSOProviderConfig[]>([]);

    const fetchConfigs = async () => {
        try {
            const res = await apiFetch('/sso/config');
            if (res.ok) {
                setConfigs(await res.json());
            } else {
                const data = await res.json().catch(() => null);
                toast.error(data?.error || data?.message || 'Failed to load SSO configuration');
            }
        } catch (error: unknown) {
            toast.error((error as Error)?.message || 'Failed to load SSO configuration');
        }
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchConfigs(); }, []);

    const enabledProviders = configs.filter(c => c.enabled).length;
    useMastheadStats([
        { label: 'PROVIDERS', value: `${configs.length}` },
        {
            label: 'ENABLED',
            value: `${enabledProviders}`,
            tone: enabledProviders > 0 ? 'value' : 'subtitle',
        },
    ]);

    const getConfig = (provider: string) => configs.find(c => c.provider === provider) || null;

    return (
          <CapabilityGate capability="sso" featureName="SSO Authentication">
            <div className="space-y-6">
                <div className="space-y-3">
                    {PROVIDERS.map(p => (
                        <ProviderCardWithGate
                            key={p.id}
                            providerId={p.id}
                            type={p.type}
                            label={p.label}
                            initialConfig={getConfig(p.id)}
                            onSave={fetchConfigs}
                        />
                    ))}
                </div>

                <div className="text-xs text-muted-foreground space-y-1">
                    <p>SSO users are automatically provisioned on first login and assigned a role based on your identity provider's group membership.</p>
                    <p>For OIDC providers, set the OAuth callback URL to: <code className="bg-muted px-1 rounded">{'https://<your-sencho-url>/api/auth/sso/oidc/<provider>/callback'}</code></p>
                </div>
            </div>
          </CapabilityGate>
    );
}
