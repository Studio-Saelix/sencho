import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { CapabilityGate } from './CapabilityGate';
import { Zap, Plus, Copy, Trash2, CheckCircle, RefreshCw, Clock, AlertTriangle } from 'lucide-react';
import { SettingsPrimaryButton } from './settings/SettingsActions';
import { SettingsCallout } from './settings/SettingsCallout';
import { useMastheadStats } from './settings/MastheadStatsContext';

interface ApiTokenListItem {
    id: number;
    name: string;
    scope: string;
    created_at: number;
    last_used_at: number | null;
    expires_at: number | null;
    revoked_at: number | null;
}

const SCOPE_LABELS: Record<string, string> = {
    'read-only': 'Read Only',
    'deploy-only': 'Deploy Only',
    'full-admin': 'Full Admin',
};

const SCOPE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
    'read-only': 'default',
    'deploy-only': 'secondary',
    'full-admin': 'destructive',
};

function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return formatDate(ts);
}

export function ApiTokensSection() {
    const [tokens, setTokens] = useState<ApiTokenListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [newToken, setNewToken] = useState<{ id: number; token: string } | null>(null);
    const [revokeTarget, setRevokeTarget] = useState<ApiTokenListItem | null>(null);
    const [loadError, setLoadError] = useState(false);

    const [formName, setFormName] = useState('');
    const [formScope, setFormScope] = useState('read-only');
    const [formExpiry, setFormExpiry] = useState<number | null>(null);

    const fetchTokens = async () => {
        try {
            const res = await apiFetch('/api-tokens', { localOnly: true });
            if (res.ok) {
                const data: ApiTokenListItem[] = await res.json();
                setTokens(data.filter(t => !t.revoked_at));
                setLoadError(false);
            } else {
                const err = await res.json().catch(() => ({}));
                setLoadError(true);
                toast.error(err?.error || err?.message || 'Failed to load API tokens.');
            }
        } catch {
            setLoadError(true);
            toast.error('Failed to load API tokens.');
        } finally { setLoading(false); }
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchTokens(); }, []);

    const handleCreate = async () => {
        if (!formName.trim()) {
            toast.error('Token name is required.');
            return;
        }
        setCreating(true);
        try {
            const res = await apiFetch('/api-tokens', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ name: formName.trim(), scope: formScope, expires_in: formExpiry }),
            });
            if (res.ok) {
                const data = await res.json();
                setNewToken({ id: data.id, token: data.token });
                setShowForm(false);
                setFormName('');
                setFormScope('read-only');
                setFormExpiry(null);
                fetchTokens();
                toast.success('API token created.');
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to create token.');
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'Network error.';
            toast.error(message);
        } finally { setCreating(false); }
    };

    const handleRevoke = async (id: number) => {
        try {
            const res = await apiFetch(`/api-tokens/${id}`, { method: 'DELETE', localOnly: true });
            if (res.ok) {
                toast.success('API token revoked.');
                fetchTokens();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to revoke token.');
            }
        } catch { toast.error('Network error.'); }
    };

    const activeTokens = tokens.filter(t => !t.revoked_at).length;
    useMastheadStats(
        loading
            ? null
            : [
                { label: 'TOKENS', value: `${activeTokens}` },
            ],
    );

    const handleCopy = async (text: string, label: string) => {
        try {
            await copyToClipboard(text);
            toast.success(`${label} copied to clipboard.`);
        } catch {
            toast.error('Failed to copy to clipboard.');
        }
    };

    return (
        <CapabilityGate capability="api-tokens" featureName="API Tokens">
            <div className="space-y-6">
                <div className="flex justify-end">
                    <SettingsPrimaryButton size="sm" onClick={() => setShowForm(!showForm)}>
                        <Plus className="w-4 h-4" strokeWidth={1.5} /> Create token
                    </SettingsPrimaryButton>
                </div>

                {/* Create form */}
                {showForm && (
                    <div className="space-y-4 bg-muted/10 p-4 border border-border rounded-xl">
                        <div className="space-y-2">
                            <Label>Name</Label>
                            <Input
                                placeholder="CI deploy pipeline"
                                value={formName}
                                onChange={e => setFormName(e.target.value)}
                                maxLength={100}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Permission Scope</Label>
                            <Combobox
                                options={[
                                    { value: 'read-only', label: 'Read Only - GET requests only' },
                                    { value: 'deploy-only', label: 'Deploy Only - read + deploy actions' },
                                    { value: 'full-admin', label: 'Full Admin - unrestricted access' },
                                ]}
                                value={formScope}
                                onValueChange={setFormScope}
                                placeholder="Select scope..."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Expiration</Label>
                            <Combobox
                                options={[
                                    { value: '30', label: '30 days' },
                                    { value: '60', label: '60 days' },
                                    { value: '90', label: '90 days' },
                                    { value: '365', label: '1 year' },
                                    { value: 'never', label: 'No expiration' },
                                ]}
                                value={formExpiry === null ? 'never' : String(formExpiry)}
                                onValueChange={v => setFormExpiry(v === 'never' ? null : Number(v))}
                                placeholder="Select expiration..."
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
                            <SettingsPrimaryButton size="sm" onClick={handleCreate} disabled={creating}>
                                {creating ? <><RefreshCw className="w-4 h-4 animate-spin" />Creating</> : 'Create'}
                            </SettingsPrimaryButton>
                        </div>
                    </div>
                )}

                {/* Token reveal (shown once after creation) */}
                {newToken && (
                    <div className="bg-success-muted border border-success/30 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2 text-sm font-medium text-success">
                            <CheckCircle className="w-4 h-4" /> Token created - copy it now
                        </div>
                        <p className="text-xs text-muted-foreground">This token will not be shown again. Store it securely.</p>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded-lg break-all select-all">{newToken.token}</code>
                            <Button variant="outline" size="sm" onClick={() => handleCopy(newToken.token, 'Token')}>
                                <Copy className="w-4 h-4" strokeWidth={1.5} />
                            </Button>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => setNewToken(null)}>Dismiss</Button>
                    </div>
                )}

                {/* Loading state */}
                {loading && (
                    <div className="space-y-3">
                        <Skeleton className="h-20 w-full rounded-xl" />
                        <Skeleton className="h-20 w-full rounded-xl" />
                    </div>
                )}

                {/* Empty state */}
                {!loading && !loadError && tokens.length === 0 && !showForm && (
                    <SettingsCallout
                        icon={<Zap className="h-4 w-4" />}
                        title="No API tokens yet"
                        subtitle="Create one to authenticate CI/CD pipelines and scripts."
                    />
                )}

                {/* Load error state */}
                {!loading && loadError && tokens.length === 0 && !showForm && (
                    <SettingsCallout
                        tone="error"
                        icon={<AlertTriangle className="h-4 w-4" />}
                        title="Couldn't load API tokens"
                        subtitle="Check your connection and try again."
                        action={
                            <Button variant="outline" size="sm" onClick={() => { setLoading(true); fetchTokens(); }}>
                                <RefreshCw className="w-4 h-4" strokeWidth={1.5} /> Retry
                            </Button>
                        }
                    />
                )}

                {/* Token list */}
                {!loading && tokens.map(token => (
                    <div key={token.id} className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                                <Zap className="w-4 h-4 text-muted-foreground shrink-0" />
                                <span className="font-medium text-sm truncate">{token.name}</span>
                                <Badge variant={SCOPE_BADGE_VARIANT[token.scope] || 'default'} className="text-[10px] shrink-0">
                                    {SCOPE_LABELS[token.scope] || token.scope}
                                </Badge>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground shrink-0"
                                onClick={() => setRevokeTarget(token)}
                            >
                                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                            </Button>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums">
                            <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                Created {formatDate(token.created_at)}
                            </span>
                            <span>
                                Last used: {token.last_used_at ? formatRelative(token.last_used_at) : 'Never'}
                            </span>
                            {token.expires_at && (
                                <span className={token.expires_at < Date.now() ? 'text-destructive' : ''}>
                                    {token.expires_at < Date.now() ? 'Expired' : `Expires ${formatDate(token.expires_at)}`}
                                </span>
                            )}
                        </div>
                    </div>
                ))}

                <ConfirmModal
                    open={revokeTarget !== null}
                    onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
                    variant="destructive"
                    kicker="API TOKEN · REVOKE · IRREVERSIBLE"
                    title="Revoke API token"
                    confirmLabel="Revoke"
                    onConfirm={() => {
                        if (revokeTarget) {
                            const id = revokeTarget.id;
                            setRevokeTarget(null);
                            handleRevoke(id);
                        }
                    }}
                >
                    <p className="text-sm text-stat-subtitle">
                        Invalidates <span className="font-medium text-stat-value">{revokeTarget?.name}</span> immediately. Any pipelines or scripts using this token will stop working.
                    </p>
                </ConfirmModal>
            </div>
        </CapabilityGate>
    );
}
