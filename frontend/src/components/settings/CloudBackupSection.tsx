import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { TogglePill } from '@/components/ui/toggle-pill';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { useLicense } from '@/context/LicenseContext';
import { Cloud, CloudOff, RefreshCw, CheckCircle2, Loader2, Trash2, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

type Provider = 'disabled' | 'sencho' | 'custom';

interface CustomConfig {
    endpoint: string;
    region: string;
    bucket: string;
    access_key: string;
    secret_key: string;
    path_prefix: string;
    auto_upload: boolean;
}

interface ConfigResponse {
    provider: Provider;
    sencho_provisioned: boolean;
    sencho_provisioned_at: string | null;
    custom: CustomConfig;
}

interface UsageResponse {
    used_bytes: number;
    quota_bytes: number;
    object_count: number;
}

interface CloudSnapshotEntry {
    objectKey: string;
    sizeBytes: number;
    lastModified: string | null;
    snapshotId: number | null;
}

const EMPTY_CUSTOM: CustomConfig = {
    endpoint: '',
    region: '',
    bucket: '',
    access_key: '',
    secret_key: '',
    path_prefix: 'sencho/',
    auto_upload: false,
};

const BASE_PROVIDER_OPTIONS = [
    { value: 'disabled', label: 'Disabled' },
    { value: 'custom', label: 'Custom S3 (BYOB)' },
];

const SENCHO_PROVIDER_OPTION = { value: 'sencho', label: 'Sencho Cloud Backup (included)' };

const PANEL_CLASS = 'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3';

const PAGE_SIZE = 10;

export function CloudBackupSection() {
    const { isPaid } = useLicense();
    const providerOptions = isPaid
        ? [BASE_PROVIDER_OPTIONS[0], SENCHO_PROVIDER_OPTION, BASE_PROVIDER_OPTIONS[1]]
        : BASE_PROVIDER_OPTIONS;
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [provider, setProvider] = useState<Provider>('disabled');
    const [senchoProvisioned, setSenchoProvisioned] = useState(false);
    const [custom, setCustom] = useState<CustomConfig>(EMPTY_CUSTOM);
    const [originalSecretSaved, setOriginalSecretSaved] = useState(false);
    const [usage, setUsage] = useState<UsageResponse | null>(null);
    const [snapshots, setSnapshots] = useState<CloudSnapshotEntry[]>([]);
    const [testing, setTesting] = useState(false);
    const [provisioning, setProvisioning] = useState(false);
    const [deleteKey, setDeleteKey] = useState<string | null>(null);
    const [page, setPage] = useState(0);

    const totalPages = Math.max(1, Math.ceil(snapshots.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pagedSnapshots = snapshots.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const needsPagination = snapshots.length > PAGE_SIZE;

    const loadConfig = useCallback(async () => {
        try {
            const res = await apiFetch('/cloud-backup/config');
            if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
            const data: ConfigResponse = await res.json();
            setProvider(data.provider);
            setSenchoProvisioned(data.sencho_provisioned);
            setCustom({ ...data.custom, secret_key: '' });
            setOriginalSecretSaved(!!data.custom.secret_key);
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to load cloud backup config.');
        } finally {
            setLoading(false);
        }
    }, []);

    const loadUsage = useCallback(async () => {
        try {
            const res = await apiFetch('/cloud-backup/usage');
            if (res.ok) setUsage(await res.json());
        } catch {
            // Usage is informational; failures shouldn't surface as toasts.
        }
    }, []);

    const loadSnapshots = useCallback(async () => {
        try {
            const res = await apiFetch('/cloud-backup/snapshots');
            if (res.ok) setSnapshots(await res.json());
        } catch {
            // Best-effort; the panel renders empty when listing fails.
        }
    }, []);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    useEffect(() => {
        if (provider === 'sencho' && senchoProvisioned) loadUsage();
    }, [provider, senchoProvisioned, loadUsage]);

    useEffect(() => {
        if (provider !== 'disabled') loadSnapshots();
        else setSnapshots([]);
    }, [provider, loadSnapshots]);

    const handleProviderChange = async (next: string) => {
        const nextProvider = next as Provider;
        setProvider(nextProvider);
        if (nextProvider === 'sencho' && !senchoProvisioned) return;
        setSaving(true);
        try {
            const body = nextProvider === 'custom' ? { provider: nextProvider, custom: { ...custom, secret_key: '' } } : { provider: nextProvider };
            const res = await apiFetch('/cloud-backup/config', {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to save provider');
            }
            toast.success('Cloud backup provider updated.');
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to update provider.');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveCustom = async () => {
        setSaving(true);
        try {
            const payload = {
                provider: 'custom',
                custom: {
                    endpoint: custom.endpoint,
                    region: custom.region,
                    bucket: custom.bucket,
                    access_key: custom.access_key,
                    secret_key: custom.secret_key || (originalSecretSaved ? '***' : ''),
                    path_prefix: custom.path_prefix,
                    auto_upload: custom.auto_upload,
                },
            };
            const res = await apiFetch('/cloud-backup/config', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to save configuration');
            }
            toast.success('Custom S3 configuration saved.');
            setCustom(c => ({ ...c, secret_key: '' }));
            setOriginalSecretSaved(true);
            loadSnapshots();
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to save configuration.');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        setTesting(true);
        try {
            const res = await apiFetch('/cloud-backup/test', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (data.success) toast.success('Connection successful.');
            else toast.error(data.error || 'Connection test failed.');
        } catch (err) {
            toast.error((err as Error)?.message || 'Connection test failed.');
        } finally {
            setTesting(false);
        }
    };

    const handleProvision = async () => {
        setProvisioning(true);
        try {
            const res = await apiFetch('/cloud-backup/provision', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.error) throw new Error(data?.error || 'Provisioning failed.');
            toast.success('Sencho Cloud Backup activated.');
            setSenchoProvisioned(true);
            await Promise.all([loadConfig(), loadUsage(), loadSnapshots()]);
        } catch (err) {
            toast.error((err as Error)?.message || 'Provisioning failed.');
        } finally {
            setProvisioning(false);
        }
    };

    const handleAutoUploadToggle = async (next: boolean) => {
        setCustom(c => ({ ...c, auto_upload: next }));
        try {
            const res = await apiFetch('/cloud-backup/config', {
                method: 'PUT',
                body: JSON.stringify({
                    provider: 'custom',
                    custom: { ...custom, auto_upload: next, secret_key: originalSecretSaved ? '***' : '' },
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to update auto-upload');
            }
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to update auto-upload.');
            setCustom(c => ({ ...c, auto_upload: !next }));
        }
    };

    const confirmDelete = async () => {
        if (!deleteKey) return;
        try {
            const encoded = btoa(deleteKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const res = await apiFetch(`/cloud-backup/object/${encoded}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to delete cloud snapshot');
            }
            toast.success('Cloud snapshot deleted.');
            loadSnapshots();
            if (provider === 'sencho') loadUsage();
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to delete cloud snapshot.');
        } finally {
            setDeleteKey(null);
        }
    };

    useMastheadStats(
        loading
            ? null
            : [
                {
                    label: 'PROVIDER',
                    value: provider,
                    tone: provider === 'disabled' ? 'subtitle' : 'value',
                },
                ...(provider === 'sencho' && usage
                    ? [{
                        label: 'USED',
                        value: `${formatBytes(usage.used_bytes)} / ${formatBytes(usage.quota_bytes)}`,
                    }]
                    : []),
                ...(snapshots.length > 0
                    ? [{ label: 'SNAPSHOTS', value: `${snapshots.length}` }]
                    : []),
            ],
    );

    if (loading) {
        return (
            <div className="space-y-3">
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-32 w-full rounded-lg" />
            </div>
        );
    }

    const usagePercent = usage && usage.quota_bytes > 0 ? Math.min(100, Math.round((usage.used_bytes / usage.quota_bytes) * 100)) : 0;
    const usageColor = usagePercent >= 90 ? 'var(--destructive)' : usagePercent >= 80 ? 'var(--warning)' : 'var(--brand)';

    return (
        <div className="space-y-6">
            <div className={PANEL_CLASS}>
                <Label className="text-sm">Storage Mode</Label>
                <Combobox
                    options={providerOptions}
                    value={provider}
                    onValueChange={handleProviderChange}
                    disabled={saving}
                />
                <p className="text-xs text-muted-foreground">
                    Choose where fleet snapshots are replicated.
                </p>
            </div>

            {isPaid && provider === 'sencho' && !senchoProvisioned && (
                <div className={PANEL_CLASS}>
                    <div className="flex items-center gap-2">
                        <Cloud className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                        <span className="font-medium text-sm">Activate Sencho Cloud Backup</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Activates a 500 MB allowance backed by Cloudflare R2, scoped to this Admiral license.
                    </p>
                    <SettingsPrimaryButton size="sm" onClick={handleProvision} disabled={provisioning}>
                        {provisioning ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} /> : <Cloud className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />}
                        Activate
                    </SettingsPrimaryButton>
                </div>
            )}

            {isPaid && provider === 'sencho' && senchoProvisioned && (
                <div className={PANEL_CLASS}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-success" strokeWidth={1.5} />
                            <span className="font-medium text-sm">Sencho Cloud Backup</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing}>
                                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} /> : null}
                                Test
                            </Button>
                            <Button size="sm" variant="ghost" onClick={handleProvision} disabled={provisioning}>
                                <RefreshCw className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
                                Reprovision
                            </Button>
                        </div>
                    </div>

                    {usage && (
                        <div className="rounded-lg border border-glass-border px-3 py-2.5 space-y-2">
                            <div className="flex items-center justify-between text-sm">
                                <span className="font-medium">Storage used</span>
                                <span className="text-stat-subtitle font-mono text-xs">
                                    {formatBytes(usage.used_bytes)} / {formatBytes(usage.quota_bytes)} ({usage.object_count} objects)
                                </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
                                <div
                                    className="h-full rounded-full transition-all duration-500"
                                    style={{
                                        width: `${usagePercent}%`,
                                        backgroundColor: usageColor,
                                        boxShadow: `0 0 8px ${usageColor}`,
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    <div className="flex items-start gap-2 rounded-lg border border-glass-border bg-muted/30 px-3 py-2.5">
                        <Cloud className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="text-xs text-muted-foreground">
                            Auto-upload is on for Sencho Cloud Backup. Every fleet snapshot is replicated within seconds.
                        </p>
                    </div>
                </div>
            )}

            {provider === 'custom' && (
                <div className={PANEL_CLASS}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <Cloud className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                            <span className="font-medium text-sm">Custom S3 Configuration</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || saving}>
                                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} /> : null}
                                Test
                            </Button>
                            <SettingsPrimaryButton size="sm" onClick={handleSaveCustom} disabled={saving}>
                                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : null}
                                Save
                            </SettingsPrimaryButton>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Endpoint URL</Label>
                            <Input
                                placeholder="https://s3.us-east-1.amazonaws.com"
                                value={custom.endpoint}
                                onChange={e => setCustom({ ...custom, endpoint: e.target.value })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Region</Label>
                            <Input
                                placeholder="us-east-1"
                                value={custom.region}
                                onChange={e => setCustom({ ...custom, region: e.target.value })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Bucket</Label>
                            <Input
                                placeholder="my-sencho-backups"
                                value={custom.bucket}
                                onChange={e => setCustom({ ...custom, bucket: e.target.value })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Path Prefix</Label>
                            <Input
                                placeholder="sencho/"
                                value={custom.path_prefix}
                                onChange={e => setCustom({ ...custom, path_prefix: e.target.value })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Access Key ID</Label>
                            <Input
                                placeholder="AKIA..."
                                value={custom.access_key}
                                onChange={e => setCustom({ ...custom, access_key: e.target.value })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Secret Access Key</Label>
                            <Input
                                type="password"
                                placeholder={originalSecretSaved && !custom.secret_key ? '•••• saved ••••' : ''}
                                value={custom.secret_key}
                                onChange={e => setCustom({ ...custom, secret_key: e.target.value })}
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
                        <div>
                            <Label className="text-sm">Auto-upload</Label>
                            <p className="text-xs text-muted-foreground">Automatically upload every fleet snapshot to this bucket.</p>
                        </div>
                        <TogglePill checked={custom.auto_upload} onChange={handleAutoUploadToggle} />
                    </div>
                </div>
            )}

            {provider !== 'disabled' && (
                <div className={PANEL_CLASS}>
                    <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">Cloud Snapshots</span>
                        <div className="flex items-center gap-1.5">
                            {needsPagination && (
                                <>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
                                        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                                    </Button>
                                    <span className="text-xs font-mono tabular-nums text-stat-subtitle min-w-[3rem] text-center">
                                        {safePage + 1} / {totalPages}
                                    </span>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} aria-label="Next page">
                                        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                                    </Button>
                                </>
                            )}
                            <Button size="sm" variant="ghost" onClick={loadSnapshots}>
                                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </Button>
                        </div>
                    </div>
                    {snapshots.length === 0 ? (
                        <div className="flex items-start gap-2 text-xs text-muted-foreground py-2">
                            <CloudOff className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                            No cloud snapshots yet. The next fleet snapshot will appear here.
                        </div>
                    ) : (
                        <ul className="space-y-1.5">
                            {pagedSnapshots.map(s => (
                                <li key={s.objectKey} className="flex items-center justify-between gap-2 rounded-md border border-glass-border px-3 py-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-mono truncate">{s.objectKey.split('/').pop()}</div>
                                        <div className="text-[10px] text-stat-subtitle font-mono">
                                            {formatBytes(s.sizeBytes)} {s.lastModified ? `· ${new Date(s.lastModified).toLocaleString()}` : ''}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={async () => {
                                                const encoded = btoa(s.objectKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                                                try {
                                                    const res = await apiFetch(`/cloud-backup/object/${encoded}/download`);
                                                    if (!res.ok) {
                                                        const err = await res.json().catch(() => ({}));
                                                        throw new Error(err?.error || `Download failed (${res.status})`);
                                                    }
                                                    const blob = await res.blob();
                                                    const link = document.createElement('a');
                                                    link.href = URL.createObjectURL(blob);
                                                    link.download = s.objectKey.split('/').pop() || 'snapshot.tar.gz';
                                                    link.click();
                                                    URL.revokeObjectURL(link.href);
                                                } catch (err) {
                                                    toast.error((err as Error)?.message || 'Download failed.');
                                                }
                                            }}
                                            title="Download"
                                        >
                                            <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => setDeleteKey(s.objectKey)}
                                            title="Delete"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <ConfirmModal
                open={!!deleteKey}
                onOpenChange={open => !open && setDeleteKey(null)}
                variant="destructive"
                kicker="CLOUD · DELETE · IRREVERSIBLE"
                title="Delete cloud snapshot"
                confirmLabel="Delete"
                onConfirm={confirmDelete}
            >
                <p className="text-sm text-stat-subtitle">
                    Permanently removes the archive from your bucket. The local SQLite copy is unaffected.
                </p>
            </ConfirmModal>
        </div>
    );
}
