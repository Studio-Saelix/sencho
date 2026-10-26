import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { TogglePill } from '@/components/ui/toggle-pill';
import { ConfirmModal, Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch, type ApiFetchOptions } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { useLicense } from '@/context/LicenseContext';
import { useExperimental } from '@/hooks/useExperimental';
import { Cloud, CloudOff, RefreshCw, CheckCircle2, Loader2, Trash2, Download, FolderInput, ChevronLeft, ChevronRight } from 'lucide-react';
import { SettingsPrimaryButton } from './SettingsActions';
import { SettingsField } from './SettingsField';
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
    encrypt_archives: boolean;
    archive_passphrase: '' | '***';
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
    encrypted: boolean;
}

type ArchiveAction = 'import' | 'download';

function cloudFetch(endpoint: string, options: ApiFetchOptions = {}) {
    return apiFetch(endpoint, { ...options, localOnly: true });
}

function encodeObjectKey(objectKey: string): string {
    return btoa(objectKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function archiveFileName(objectKey: string): string {
    const base = objectKey.split('/').pop() || 'snapshot.tar.gz';
    return base.endsWith('.senc') ? base.slice(0, -'.senc'.length) : base;
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

const SENCHO_PROVIDER_OPTION = { value: 'sencho', label: 'Sencho Snapshot Vault (included)' };

const PANEL_CLASS = 'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3';

const PAGE_SIZE = 10;

// Mirrors what PUT /cloud-backup/config requires for a custom provider, so the
// picker only saves a selection the server will accept.
function isCustomConfigSavable(c: CustomConfig): boolean {
    return !!c.endpoint.trim() && !!c.bucket.trim() && !!c.access_key.trim() && /^https?:\/\//i.test(c.endpoint.trim());
}

export function CloudBackupSection() {
    const { isPaid } = useLicense();
    const { experimental } = useExperimental();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [provider, setProvider] = useState<Provider>('disabled');
    const [loadedProvider, setLoadedProvider] = useState<Provider>('disabled');
    // Last provider the server confirmed, so a failed save returns the picker
    // to what is actually stored rather than to an unsaved local selection.
    const savedProviderRef = useRef<Provider>('disabled');
    // Set when the stored configuration could not be read: there is no
    // confirmed server state to roll back to, so the picker stays locked until
    // a retry succeeds.
    const [loadFailed, setLoadFailed] = useState(false);
    // Admiral only: the managed vault is discoverable with the experimental
    // flag on, or when the last-loaded config had provider 'sencho'. In that
    // case the option stays for the session, so switching away (or a failed
    // save) never removes the way back.
    const senchoVisible = isPaid && (experimental || loadedProvider === 'sencho');
    const providerOptions = senchoVisible
        ? [BASE_PROVIDER_OPTIONS[0], SENCHO_PROVIDER_OPTION, BASE_PROVIDER_OPTIONS[1]]
        : BASE_PROVIDER_OPTIONS;
    const [senchoProvisioned, setSenchoProvisioned] = useState(false);
    const [custom, setCustom] = useState<CustomConfig>(EMPTY_CUSTOM);
    const [originalSecretSaved, setOriginalSecretSaved] = useState(false);
    const [usage, setUsage] = useState<UsageResponse | null>(null);
    const [snapshots, setSnapshots] = useState<CloudSnapshotEntry[]>([]);
    const [testing, setTesting] = useState(false);
    const [provisioning, setProvisioning] = useState(false);
    const [deleteKey, setDeleteKey] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [encryptArchives, setEncryptArchives] = useState(false);
    const [passphraseSaved, setPassphraseSaved] = useState(false);
    const [pendingEnable, setPendingEnable] = useState(false);
    const [passphraseDraft, setPassphraseDraft] = useState('');
    const [passphraseError, setPassphraseError] = useState('');
    const [savingEncryption, setSavingEncryption] = useState(false);
    const [archivePrompt, setArchivePrompt] = useState<{ objectKey: string; action: ArchiveAction } | null>(null);
    const [promptPassphrase, setPromptPassphrase] = useState('');
    const [promptError, setPromptError] = useState('');
    const [archiveBusy, setArchiveBusy] = useState(false);

    const totalPages = Math.max(1, Math.ceil(snapshots.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pagedSnapshots = snapshots.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const needsPagination = snapshots.length > PAGE_SIZE;

    const loadConfig = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/config');
            if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
            const data: ConfigResponse = await res.json();
            setProvider(data.provider);
            setLoadedProvider(data.provider);
            savedProviderRef.current = data.provider;
            setLoadFailed(false);
            setSenchoProvisioned(data.sencho_provisioned);
            setCustom({ ...data.custom, secret_key: '' });
            setOriginalSecretSaved(!!data.custom.secret_key);
            setEncryptArchives(data.encrypt_archives === true);
            setPassphraseSaved(data.archive_passphrase === '***');
            setPendingEnable(false);
        } catch (err) {
            setLoadFailed(true);
            toast.error((err as Error)?.message || 'Failed to load cloud backup config.');
        } finally {
            setLoading(false);
        }
    }, []);

    const loadUsage = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/usage');
            if (res.ok) setUsage(await res.json());
        } catch {
            // Usage is informational; failures shouldn't surface as toasts.
        }
    }, []);

    const loadSnapshots = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/snapshots');
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
        // A blank custom form is filled in and saved with Save, not by the picker.
        if (nextProvider === 'custom' && !isCustomConfigSavable(custom)) return;
        setSaving(true);
        try {
            const body = nextProvider === 'custom' ? { provider: nextProvider, custom: { ...custom, secret_key: '' } } : { provider: nextProvider };
            const res = await cloudFetch('/cloud-backup/config', {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to save provider');
            }
            savedProviderRef.current = nextProvider;
            toast.success('Cloud backup provider updated.');
        } catch (err) {
            setProvider(savedProviderRef.current);
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
            const res = await cloudFetch('/cloud-backup/config', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to save configuration');
            }
            savedProviderRef.current = 'custom';
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
            const res = await cloudFetch('/cloud-backup/test', { method: 'POST' });
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
            const res = await cloudFetch('/cloud-backup/provision', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.error) throw new Error(data?.error || 'Provisioning failed.');
            toast.success('Sencho Snapshot Vault activated.');
            setSenchoProvisioned(true);
            await Promise.all([loadConfig(), loadUsage(), loadSnapshots()]);
        } catch (err) {
            toast.error((err as Error)?.message || 'Provisioning failed.');
        } finally {
            setProvisioning(false);
        }
    };

    const persistEncryption = async (enabled: boolean, passphrase: string) => {
        const body: Record<string, unknown> = {
            provider,
            encrypt_archives: enabled,
            archive_passphrase: passphrase,
        };
        if (provider === 'custom') {
            body.custom = {
                ...custom,
                secret_key: custom.secret_key || (originalSecretSaved ? '***' : ''),
            };
        }
        const res = await cloudFetch('/cloud-backup/config', {
            method: 'PUT',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error || 'Failed to save archive encryption');
        }
    };

    const handleEncryptToggle = async (next: boolean) => {
        if (next && !passphraseSaved) {
            setPendingEnable(true);
            return;
        }
        if (!next && !encryptArchives) {
            setPendingEnable(false);
            return;
        }
        setEncryptArchives(next);
        setPendingEnable(false);
        setSavingEncryption(true);
        try {
            await persistEncryption(next, '***');
            toast.success(next ? 'Archive encryption on.' : 'Archive encryption off.');
        } catch (err) {
            setEncryptArchives(!next);
            toast.error((err as Error)?.message || 'Failed to save archive encryption.');
        } finally {
            setSavingEncryption(false);
        }
    };

    const handleSavePassphrase = async () => {
        if (passphraseDraft.length < 12) {
            setPassphraseError('Use at least 12 characters.');
            return;
        }
        setPassphraseError('');
        setSavingEncryption(true);
        const enabling = encryptArchives || pendingEnable;
        try {
            await persistEncryption(enabling, passphraseDraft);
            setEncryptArchives(enabling);
            setPendingEnable(false);
            setPassphraseSaved(true);
            setPassphraseDraft('');
            toast.success('Archive passphrase saved.');
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to save archive encryption.');
        } finally {
            setSavingEncryption(false);
        }
    };

    const requestArchive = async (objectKey: string, action: ArchiveAction, passphrase: string | null) => {
        setArchiveBusy(true);
        try {
            const encoded = encodeObjectKey(objectKey);
            const withPass = !!passphrase;
            const path = action === 'import'
                ? `/cloud-backup/object/${encoded}/import`
                : `/cloud-backup/object/${encoded}/download`;
            const res = await cloudFetch(path, withPass || action === 'import'
                ? { method: 'POST', body: JSON.stringify(withPass ? { passphrase } : {}) }
                : { method: 'GET' });
            if (res.ok) {
                if (action === 'download') {
                    const blob = await res.blob();
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = archiveFileName(objectKey);
                    link.click();
                    URL.revokeObjectURL(link.href);
                } else {
                    toast.success('Imported as a new local snapshot.');
                }
                setArchivePrompt(null);
                setPromptPassphrase('');
                setPromptError('');
                return;
            }
            const err = await res.json().catch(() => ({}));
            if (err.code === 'PASSPHRASE_REQUIRED' || err.code === 'INVALID_PASSPHRASE') {
                setArchivePrompt({ objectKey, action });
                setPromptError(err.code === 'INVALID_PASSPHRASE' ? (err.error || 'Passphrase is incorrect') : '');
                return;
            }
            throw new Error(err.error || (action === 'import' ? 'Import failed' : 'Download failed'));
        } catch (err) {
            toast.error((err as Error)?.message || 'Request failed.');
        } finally {
            setArchiveBusy(false);
        }
    };

    const handleAutoUploadToggle = async (next: boolean) => {
        setCustom(c => ({ ...c, auto_upload: next }));
        try {
            const res = await cloudFetch('/cloud-backup/config', {
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
            const res = await cloudFetch(`/cloud-backup/object/${encodeObjectKey(deleteKey)}`, { method: 'DELETE' });
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

    const handleRetryLoad = async () => {
        setLoading(true);
        await loadConfig();
    };

    useMastheadStats(
        loading || loadFailed
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

    const encryptionFields = (
        <>
            <SettingsField
                label="Encrypt archives"
                helper="Seal off-site archives before they leave this instance. Off by default."
                htmlFor="archive-encryption"
            >
                <TogglePill
                    id="archive-encryption"
                    aria-label="Encrypt archives"
                    checked={encryptArchives}
                    disabled={savingEncryption}
                    onChange={handleEncryptToggle}
                />
            </SettingsField>
            {(encryptArchives || passphraseSaved || pendingEnable) && (
                <SettingsField
                    label="Archive passphrase"
                    tone="warn"
                    align="start"
                    htmlFor="archive-passphrase"
                    helper="The provider stores ciphertext. A lost passphrase cannot be recovered. Turning encryption off leaves archives that are already uploaded sealed, and a new passphrase applies only to later uploads."
                >
                    <div className="flex flex-col gap-2">
                        <Input
                            id="archive-passphrase"
                            type="password"
                            autoComplete="new-password"
                            value={passphraseDraft}
                            placeholder={passphraseSaved ? 'Saved. Type a new passphrase to replace it.' : 'At least 12 characters'}
                            onChange={e => {
                                setPassphraseDraft(e.target.value);
                                if (passphraseError) setPassphraseError('');
                            }}
                        />
                        {passphraseError ? <p className="text-sm text-destructive">{passphraseError}</p> : null}
                        {passphraseDraft ? (
                            <BusyButton
                                size="sm"
                                className="self-start"
                                pending={savingEncryption}
                                busyLabel="Saving"
                                onClick={handleSavePassphrase}
                            >
                                Save passphrase
                            </BusyButton>
                        ) : null}
                    </div>
                </SettingsField>
            )}
        </>
    );

    return (
        <div className="space-y-6">
            <div className={PANEL_CLASS}>
                <Label className="text-sm">Storage Mode</Label>
                <Combobox
                    options={providerOptions}
                    value={provider}
                    onValueChange={handleProviderChange}
                    disabled={saving || loadFailed}
                />
                <p className="text-xs text-muted-foreground">
                    Choose where fleet snapshots are replicated.
                </p>
                {loadFailed && (
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-destructive">
                            The stored configuration could not be read, so the storage mode is locked.
                        </p>
                        <Button size="sm" variant="outline" onClick={handleRetryLoad}>
                            Retry
                        </Button>
                    </div>
                )}
            </div>

            {isPaid && provider === 'sencho' && !senchoProvisioned && (
                <div className={PANEL_CLASS}>
                    <div className="flex items-center gap-2">
                        <Cloud className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                        <span className="font-medium text-sm">Activate Sencho Snapshot Vault</span>
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
                            <span className="font-medium text-sm">Sencho Snapshot Vault</span>
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
                            Auto-upload is on for Sencho Snapshot Vault. Every fleet snapshot is replicated within seconds.
                        </p>
                    </div>
                    {encryptionFields}
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
                    {encryptionFields}
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
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-7 w-7"
                                                        aria-label="Import snapshot"
                                                        onClick={() => requestArchive(s.objectKey, 'import', null)}
                                                    >
                                                        <FolderInput className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>Import</TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-7 w-7"
                                                        aria-label="Download snapshot"
                                                        onClick={() => requestArchive(s.objectKey, 'download', null)}
                                                    >
                                                        <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>Download</TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-7 w-7"
                                                        onClick={() => setDeleteKey(s.objectKey)}
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>Delete</TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
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

            <Modal
                open={archivePrompt !== null}
                onOpenChange={open => {
                    if (open || archiveBusy) return;
                    setArchivePrompt(null);
                    setPromptPassphrase('');
                    setPromptError('');
                }}
            >
                <ModalHeader
                    kicker="CLOUD · ARCHIVE"
                    title={archivePrompt?.action === 'download' ? 'Download snapshot' : 'Import snapshot'}
                />
                <ModalBody className="space-y-3">
                    {archivePrompt?.action !== 'download' && (
                        <p className="text-sm text-stat-subtitle">
                            This adds a new local snapshot. Live stack files stay as they are. Importing the same archive again adds another copy.
                        </p>
                    )}
                    <div className="space-y-1.5">
                        <Label htmlFor="archive-prompt-passphrase" className="text-sm">Passphrase for this archive</Label>
                        <Input
                            id="archive-prompt-passphrase"
                            type="password"
                            autoComplete="current-password"
                            value={promptPassphrase}
                            onChange={e => setPromptPassphrase(e.target.value)}
                        />
                    </div>
                    {promptError ? <p className="text-sm text-destructive">{promptError}</p> : null}
                </ModalBody>
                <ModalFooter
                    secondary={<Button variant="outline" onClick={() => setArchivePrompt(null)} disabled={archiveBusy}>Cancel</Button>}
                    primary={(
                        <BusyButton
                            pending={archiveBusy}
                            busyLabel={archivePrompt?.action === 'download' ? 'Downloading' : 'Importing'}
                            onClick={() => {
                                if (!archivePrompt) return;
                                void requestArchive(archivePrompt.objectKey, archivePrompt.action, promptPassphrase);
                            }}
                        >
                            {archivePrompt?.action === 'download' ? 'Download' : 'Import'}
                        </BusyButton>
                    )}
                />
            </Modal>
        </div>
    );
}
