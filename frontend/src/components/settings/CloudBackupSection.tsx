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

// The Custom S3 fields that decide which bucket and objects the server acts
// on. Auto-upload and the secret are not part of the destination's identity.
const DESTINATION_FIELDS = ['endpoint', 'region', 'bucket', 'access_key', 'path_prefix'] as const;
type CustomDestination = Pick<CustomConfig, typeof DESTINATION_FIELDS[number]>;

// What the server last confirmed as stored, which every destination-bound
// request resolves against. The picker and the Custom S3 form hold a draft
// that can differ.
interface ConfirmedDestination {
    provider: Provider;
    custom: CustomDestination;
}

function customDestination(c: CustomConfig): CustomDestination {
    return {
        endpoint: c.endpoint, region: c.region, bucket: c.bucket,
        access_key: c.access_key, path_prefix: c.path_prefix,
    } satisfies Record<typeof DESTINATION_FIELDS[number], string>;
}

function sameCustomDestination(a: CustomDestination, b: CustomDestination): boolean {
    return DESTINATION_FIELDS.every(field => a[field] === b[field]);
}

function sameDestination(a: ConfirmedDestination, b: ConfirmedDestination): boolean {
    return a.provider === b.provider && (a.provider !== 'custom' || sameCustomDestination(a.custom, b.custom));
}

// The server answered and refused a configuration write, so nothing was stored.
// Any other failure (a dropped connection, a timeout) leaves the stored
// destination unknown.
class ConfigRejectedError extends Error {}

async function putConfig(body: unknown, fallback: string): Promise<void> {
    const res = await cloudFetch('/cloud-backup/config', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new ConfigRejectedError(err?.error || fallback);
    }
}

// Every request the panel holds a control on is bounded, so a hub or S3
// endpoint that never answers releases the hold with an error instead of
// leaving Save, the picker and Auto-upload disabled until the page is left.
// A transfer (import, download, recover) gets longer because it moves a whole
// archive.
const REQUEST_DEADLINE_MS = 60_000;
const TRANSFER_DEADLINE_MS = 180_000;

class RequestTimeoutError extends Error {
    constructor(deadlineMs: number) {
        super(`The request timed out after ${Math.round(deadlineMs / 1000)} seconds.`);
    }
}

function cloudFetch(endpoint: string, options: ApiFetchOptions = {}, deadlineMs = REQUEST_DEADLINE_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = new RequestTimeoutError(deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            // Aborting also cuts a body that stalls after the headers arrived,
            // which is why the timer is not cleared when the response does.
            controller.abort(timeout);
            reject(timeout);
        }, deadlineMs);
    });
    const request = apiFetch(endpoint, { ...options, localOnly: true, signal: controller.signal });
    request.catch(() => clearTimeout(timer));
    return Promise.race([request, expired]);
}

function encodeObjectKey(objectKey: string): string {
    // The API decodes this path segment as UTF-8. btoa() alone only accepts
    // Latin-1 and throws on any other character, so encode the string's UTF-8
    // bytes first; a configured prefix must survive every archive action.
    let binary = '';
    for (const byte of new TextEncoder().encode(objectKey)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

const INITIAL_CONFIRMED: ConfirmedDestination = { provider: 'disabled', custom: customDestination(EMPTY_CUSTOM) };

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
    return /^https?:\/\//i.test(c.endpoint.trim()) && !!c.bucket.trim() && !!c.access_key.trim();
}

export function CloudBackupSection() {
    const { isPaid } = useLicense();
    const { experimental } = useExperimental();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [provider, setProvider] = useState<Provider>('disabled');
    const [loadedProvider, setLoadedProvider] = useState<Provider>('disabled');
    // The destination the server last confirmed. A failed save returns the
    // picker to it, and Test, the archive list and every archive action are
    // offered only while the displayed destination equals it. The ref serves
    // async handlers; the state drives rendering.
    const confirmedRef = useRef<ConfirmedDestination>(INITIAL_CONFIRMED);
    const [confirmed, setConfirmed] = useState<ConfirmedDestination>(INITIAL_CONFIRMED);
    // Set when the stored configuration could not be read: there is no
    // confirmed server state to roll back to, so the picker stays locked until
    // a retry succeeds.
    const [loadFailed, setLoadFailed] = useState(false);
    const [retrying, setRetrying] = useState(false);
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
    const [snapshotsLoading, setSnapshotsLoading] = useState(false);
    const [snapshotsError, setSnapshotsError] = useState('');
    const [testing, setTesting] = useState(false);
    const [provisioning, setProvisioning] = useState(false);
    const [deleteKey, setDeleteKey] = useState<string | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
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
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const [recoveryArchives, setRecoveryArchives] = useState<CloudSnapshotEntry[]>([]);
    const [recoveryTruncated, setRecoveryTruncated] = useState(false);
    const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
    const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
    const [recoveryError, setRecoveryError] = useState('');
    const [recoveryLoading, setRecoveryLoading] = useState(false);
    const [recoveryListError, setRecoveryListError] = useState('');
    const [recoveryBusy, setRecoveryBusy] = useState(false);
    // A ref, not the state flag: two clicks in the same tick both see the
    // pre-render value of state, and a double-click must issue one request.
    const archiveBusyRef = useRef(false);
    const recoveryBusyRef = useRef(false);
    const deleteBusyRef = useRef(false);
    // Discovery can be restarted (reopen, retry) while an earlier listing is
    // still in flight; only the newest request may write its result.
    const recoveryListSeqRef = useRef(0);
    // Same for the normal listing: a response that began before the confirmed
    // destination changed describes the old destination and is dropped.
    const snapshotSeqRef = useRef(0);
    // The recovery error is rendered above the archive list and the effect
    // below scrolls it into view, so a failed passphrase is visible even when
    // the operator scrolled to the passphrase field at the bottom of a long
    // list.
    const recoveryErrorRef = useRef<HTMLParagraphElement | null>(null);

    // The destination on screen is the confirmed one only when no config load
    // failed, the picker has not moved off it, and the Custom S3 form has no
    // unsaved edits. Until then Test and the archive list stay out of reach,
    // because the server resolves them against the confirmed destination, not
    // the draft. A write in flight holds the actions too (destinationReady).
    const customDraftDirty = provider === 'custom' && confirmed.provider === 'custom'
        && (custom.secret_key !== '' || !sameCustomDestination(customDestination(custom), confirmed.custom));
    const destinationShown = !loadFailed && provider !== 'disabled' && provider === confirmed.provider && !customDraftDirty;
    const destinationReady = destinationShown && !saving && !provisioning;
    // A destination write must not start while a Test, provision, archive,
    // delete or recovery request that resolves against the current destination
    // is still running.
    const operationBusy = testing || provisioning || archiveBusy || deleteBusy || recoveryBusy;
    const provisionBlocked = loadFailed || saving || operationBusy;

    const totalPages = Math.max(1, Math.ceil(snapshots.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pagedSnapshots = snapshots.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const needsPagination = snapshots.length > PAGE_SIZE;

    const loadSnapshots = useCallback(async () => {
        const seq = ++snapshotSeqRef.current;
        setSnapshotsLoading(true);
        setSnapshotsError('');
        try {
            const res = await cloudFetch('/cloud-backup/snapshots');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || `Failed to list cloud snapshots (${res.status})`);
            }
            const data = await res.json();
            if (seq === snapshotSeqRef.current) setSnapshots(data);
        } catch (err) {
            if (seq === snapshotSeqRef.current) {
                setSnapshots([]);
                setSnapshotsError((err as Error)?.message || 'Failed to list cloud snapshots.');
            }
        } finally {
            if (seq === snapshotSeqRef.current) setSnapshotsLoading(false);
        }
    }, []);

    // Called whenever the server confirms a destination (config load, picker
    // save, Custom S3 save, auto-upload save). A different destination drops
    // the inventory scoped to the previous one and any listing still in flight.
    // The dialogs that hold object keys are modal and the picker is held while
    // they run, so none can be open when the destination changes. Returns
    // whether the destination changed.
    const confirmDestination = useCallback((provider: Provider, custom: CustomDestination): boolean => {
        const next: ConfirmedDestination = { provider, custom };
        const changed = !sameDestination(confirmedRef.current, next);
        confirmedRef.current = next;
        setConfirmed(next);
        if (!changed) return false;
        snapshotSeqRef.current += 1;
        setSnapshots([]);
        setSnapshotsError('');
        setSnapshotsLoading(false);
        setPage(0);
        setUsage(null);
        if (provider !== 'disabled') void loadSnapshots();
        return true;
    }, [loadSnapshots]);

    // After a write that failed without an answer, the server may or may not
    // have stored it. Read the stored destination back so nothing is offered
    // against a guess; if that read fails too, lock the section until Retry.
    const resyncConfirmed = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/config');
            if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
            const data: ConfigResponse = await res.json();
            confirmDestination(data.provider, customDestination(data.custom));
            setProvider(data.provider);
        } catch {
            setLoadFailed(true);
            setProvider(confirmedRef.current.provider);
        }
    }, [confirmDestination]);

    const loadConfig = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/config');
            if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
            const data: ConfigResponse = await res.json();
            setProvider(data.provider);
            setLoadedProvider(data.provider);
            confirmDestination(data.provider, customDestination(data.custom));
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
    }, [confirmDestination]);

    const loadUsage = useCallback(async () => {
        try {
            const res = await cloudFetch('/cloud-backup/usage');
            if (res.ok) setUsage(await res.json());
        } catch {
            // Usage is informational; failures shouldn't surface as toasts.
        }
    }, []);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    useEffect(() => {
        if (confirmed.provider === 'sencho' && senchoProvisioned) loadUsage();
    }, [confirmed.provider, senchoProvisioned, loadUsage]);

    useEffect(() => {
        if (!recoveryError) return;
        const error = recoveryErrorRef.current;
        if (error && typeof error.scrollIntoView === 'function') {
            error.scrollIntoView({ block: 'nearest' });
        }
    }, [recoveryError]);

    const handleProviderChange = async (next: string) => {
        const nextProvider = next as Provider;
        setProvider(nextProvider);
        if (nextProvider === 'sencho' && !senchoProvisioned) return;
        // A blank custom form is filled in and saved with Save, not by the picker.
        if (nextProvider === 'custom' && !isCustomConfigSavable(custom)) return;
        setSaving(true);
        try {
            const body = nextProvider === 'custom' ? { provider: nextProvider, custom: { ...custom, secret_key: '' } } : { provider: nextProvider };
            await putConfig(body, 'Failed to save provider');
            confirmDestination(nextProvider, nextProvider === 'custom' ? customDestination(custom) : confirmedRef.current.custom);
            toast.success('Cloud backup provider updated.');
        } catch (err) {
            setProvider(confirmedRef.current.provider);
            toast.error((err as Error)?.message || 'Failed to update provider.');
            if (!(err instanceof ConfigRejectedError)) await resyncConfirmed();
        } finally {
            setSaving(false);
        }
    };

    // Writes the whole visible Custom S3 form, which is what both Save and the
    // auto-upload toggle do. Resolves true when the write changed what the
    // operator is looking at: a different destination, or a secret that was sent.
    const persistCustom = async (autoUpload: boolean, fallback: string): Promise<boolean> => {
        const sentSecret = custom.secret_key;
        await putConfig({
            provider: 'custom',
            custom: {
                endpoint: custom.endpoint,
                region: custom.region,
                bucket: custom.bucket,
                access_key: custom.access_key,
                secret_key: sentSecret || (originalSecretSaved ? '***' : ''),
                path_prefix: custom.path_prefix,
                auto_upload: autoUpload,
            },
        }, fallback);
        const changed = confirmDestination('custom', customDestination(custom));
        // Keep a secret the operator typed while the request was in flight.
        setCustom(c => (c.secret_key === sentSecret ? { ...c, secret_key: '' } : c));
        setOriginalSecretSaved(true);
        return changed || sentSecret !== '';
    };

    const handleSaveCustom = async () => {
        setSaving(true);
        try {
            await persistCustom(custom.auto_upload, 'Failed to save configuration');
            toast.success('Custom S3 configuration saved.');
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to save configuration.');
            if (!(err instanceof ConfigRejectedError)) await resyncConfirmed();
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!destinationReady) return;
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
        if (provisionBlocked) return;
        setProvisioning(true);
        try {
            const res = await cloudFetch('/cloud-backup/provision', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.error) throw new Error(data?.error || 'Provisioning failed.');
            toast.success('Sencho Snapshot Vault activated.');
            setSenchoProvisioned(true);
            // The refreshes report their own failures; the hold covers the
            // provision call only.
            void Promise.all([loadConfig(), loadUsage(), loadSnapshots()]);
        } catch (err) {
            toast.error((err as Error)?.message || 'Provisioning failed.');
        } finally {
            setProvisioning(false);
        }
    };

    const persistEncryption = async (enabled: boolean, passphrase: string) => {
        // Encryption only. The destination and its credentials are saved by
        // their own Save action, so toggling encryption never submits an
        // unsaved S3 draft.
        const body = {
            encrypt_archives: enabled,
            archive_passphrase: passphrase,
        };
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
        if (!destinationReady || archiveBusyRef.current || deleteBusyRef.current) return;
        archiveBusyRef.current = true;
        setArchiveBusy(true);
        try {
            const encoded = encodeObjectKey(objectKey);
            const withPass = !!passphrase;
            const path = action === 'import'
                ? `/cloud-backup/object/${encoded}/import`
                : `/cloud-backup/object/${encoded}/download`;
            const res = await cloudFetch(path, withPass || action === 'import'
                ? { method: 'POST', body: JSON.stringify(withPass ? { passphrase } : {}) }
                : { method: 'GET' }, TRANSFER_DEADLINE_MS);
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
            archiveBusyRef.current = false;
            setArchiveBusy(false);
        }
    };

    const loadRecoveryArchives = useCallback(async () => {
        const seq = ++recoveryListSeqRef.current;
        setRecoveryLoading(true);
        setRecoveryListError('');
        setRecoveryArchives([]);
        setRecoveryTruncated(false);
        // A retry starts a new listing, so a selection made against the
        // previous one no longer describes an archive we can see.
        setRecoveryKey(null);
        setRecoveryPassphrase('');
        setRecoveryError('');
        try {
            const res = await cloudFetch('/cloud-backup/recovery-archives');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || `Failed to list recovery archives (${res.status})`);
            }
            const data = await res.json() as { entries: CloudSnapshotEntry[]; truncated: boolean };
            if (seq !== recoveryListSeqRef.current) return;
            setRecoveryArchives(data.entries);
            setRecoveryTruncated(data.truncated === true);
        } catch (err) {
            if (seq !== recoveryListSeqRef.current) return;
            setRecoveryListError((err as Error)?.message || 'Failed to list recovery archives.');
        } finally {
            if (seq === recoveryListSeqRef.current) setRecoveryLoading(false);
        }
    }, []);

    const openRecovery = () => {
        if (!destinationReady) return;
        setRecoveryOpen(true);
        void loadRecoveryArchives();
    };

    const handleRecover = async () => {
        if (!destinationReady || !recoveryKey || recoveryBusyRef.current || deleteBusyRef.current) return;
        if (!recoveryPassphrase) {
            setRecoveryError('Enter the passphrase that sealed this archive.');
            return;
        }
        recoveryBusyRef.current = true;
        setRecoveryBusy(true);
        setRecoveryError('');
        try {
            const res = await cloudFetch('/cloud-backup/recover', {
                method: 'POST',
                body: JSON.stringify({ object_key: recoveryKey, passphrase: recoveryPassphrase }),
            }, TRANSFER_DEADLINE_MS);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Recovery failed');
            }
            toast.success('Archive recovered as an imported snapshot. Find it in Fleet → Snapshots.');
            setRecoveryOpen(false);
            loadSnapshots();
        } catch (err) {
            setRecoveryError((err as Error)?.message || 'Recovery failed.');
        } finally {
            recoveryBusyRef.current = false;
            setRecoveryBusy(false);
        }
    };

    const handleAutoUploadToggle = async (next: boolean) => {
        setCustom(c => ({ ...c, auto_upload: next }));
        setSaving(true);
        try {
            // The write carries the visible form, so say so when it stored a
            // different destination or secret than the operator last saved.
            if (await persistCustom(next, 'Failed to update auto-upload')) toast.success('Custom S3 configuration saved.');
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to update auto-upload.');
            setCustom(c => ({ ...c, auto_upload: !next }));
            if (!(err instanceof ConfigRejectedError)) await resyncConfirmed();
        } finally {
            setSaving(false);
        }
    };

    const confirmDelete = async () => {
        if (!deleteKey || deleteBusyRef.current || archiveBusyRef.current || recoveryBusyRef.current) return;
        if (!destinationReady) {
            setDeleteKey(null);
            return;
        }
        deleteBusyRef.current = true;
        setDeleteBusy(true);
        try {
            const res = await cloudFetch(`/cloud-backup/object/${encodeObjectKey(deleteKey)}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to delete cloud snapshot');
            }
            toast.success('Cloud snapshot deleted.');
            loadSnapshots();
            if (confirmed.provider === 'sencho') loadUsage();
        } catch (err) {
            toast.error((err as Error)?.message || 'Failed to delete cloud snapshot.');
        } finally {
            deleteBusyRef.current = false;
            setDeleteBusy(false);
            setDeleteKey(null);
        }
    };

    const handleRetryLoad = async () => {
        setRetrying(true);
        try {
            await loadConfig();
        } finally {
            setRetrying(false);
        }
    };

    useMastheadStats(
        loading || loadFailed
            ? null
            : [
                {
                    label: 'PROVIDER',
                    value: confirmed.provider,
                    tone: confirmed.provider === 'disabled' ? 'subtitle' : 'value',
                },
                ...(confirmed.provider === 'sencho' && usage
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
                    disabled={savingEncryption || saving}
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
                    disabled={saving || savingEncryption || loadFailed || operationBusy}
                />
                <p className="text-xs text-muted-foreground">
                    Choose where fleet snapshots are replicated.
                </p>
                {loadFailed && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-destructive">
                            The stored configuration could not be read, so the storage mode is locked.
                        </p>
                        <BusyButton size="sm" variant="outline" pending={retrying} busyLabel="Retrying" onClick={handleRetryLoad}>
                            Retry
                        </BusyButton>
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
                    <SettingsPrimaryButton size="sm" onClick={handleProvision} disabled={provisionBlocked}>
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
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || !destinationReady}>
                                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} /> : null}
                                Test
                            </Button>
                            <Button size="sm" variant="ghost" onClick={handleProvision} disabled={provisionBlocked}>
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
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing || !destinationReady}>
                                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} /> : null}
                                Test
                            </Button>
                            <SettingsPrimaryButton size="sm" onClick={handleSaveCustom} disabled={saving || operationBusy}>
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
                        <TogglePill checked={custom.auto_upload} disabled={saving || operationBusy} onChange={handleAutoUploadToggle} />
                    </div>
                    {encryptionFields}
                </div>
            )}

            {provider !== 'disabled' && !loadFailed && !destinationShown && (
                <div className={PANEL_CLASS}>
                    <span className="font-medium text-sm">Cloud Snapshots</span>
                    <div className="flex items-start gap-2 text-xs text-muted-foreground py-2">
                        <CloudOff className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                        {provider === 'sencho'
                            ? 'Snapshots and recovery appear, and Test is available, once the Sencho Snapshot Vault is active.'
                            : 'Snapshots and recovery appear, and Test is available, once this Custom S3 configuration is saved.'}
                    </div>
                </div>
            )}

            {destinationShown && (
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
                            <Button size="sm" variant="ghost" aria-label="Refresh snapshots" onClick={() => void loadSnapshots()} disabled={archiveBusy || !destinationReady || snapshotsLoading}>
                                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </Button>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-glass-border px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                            Lost the original instance? Recover one of its sealed archives with its passphrase.
                        </p>
                        <Button size="sm" variant="outline" onClick={openRecovery} disabled={archiveBusy || !destinationReady}>
                            Recover archive
                        </Button>
                    </div>
                    {snapshotsLoading ? (
                        <div role="status" aria-busy="true" className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                            <Loader2 className="w-4 h-4 animate-spin shrink-0" strokeWidth={1.5} />
                            Loading cloud snapshots...
                        </div>
                    ) : snapshotsError ? (
                        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                            <p className="text-xs text-destructive">{snapshotsError}</p>
                            <Button size="sm" variant="outline" onClick={() => void loadSnapshots()} disabled={!destinationReady}>
                                Try again
                            </Button>
                        </div>
                    ) : snapshots.length === 0 ? (
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
                                                        disabled={archiveBusy || !destinationReady}
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
                                                        disabled={archiveBusy || !destinationReady}
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
                                                        aria-label="Delete snapshot"
                                                        disabled={archiveBusy || deleteBusy || !destinationReady}
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
                confirming={deleteBusy}
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

            <Modal
                open={recoveryOpen}
                onOpenChange={open => {
                    if (open || recoveryBusy) return;
                    setRecoveryOpen(false);
                }}
            >
                <ModalHeader kicker="CLOUD · RECOVERY" title="Recover an archive from another instance" />
                <ModalBody className="space-y-3">
                    <p className="text-sm text-stat-subtitle">
                        Archives from other instances in this bucket are listed here. Recovery needs the passphrase that sealed the archive, and the imported snapshot stays unmapped until you choose destination nodes in Fleet → Snapshots.
                    </p>
                    {recoveryError ? (
                        <p
                            ref={recoveryErrorRef}
                            role="alert"
                            className="text-sm text-destructive"
                        >
                            {recoveryError}
                        </p>
                    ) : null}
                    {recoveryLoading ? (
                        <div role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-stat-subtitle">
                            <Loader2 className="w-4 h-4 animate-spin shrink-0" strokeWidth={1.5} />
                            Looking for sealed archives from other instances...
                        </div>
                    ) : recoveryListError ? (
                        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                            <p className="text-sm text-destructive">{recoveryListError}</p>
                            <Button size="sm" variant="outline" onClick={() => void loadRecoveryArchives()}>
                                Try again
                            </Button>
                        </div>
                    ) : recoveryArchives.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No sealed archives from other instances were found.
                        </p>
                    ) : (
                        <ul className="space-y-1.5">
                            {recoveryArchives.map(entry => (
                                <li key={entry.objectKey}>
                                    <button
                                        type="button"
                                        aria-pressed={recoveryKey === entry.objectKey}
                                        disabled={!entry.encrypted}
                                        onClick={() => setRecoveryKey(entry.objectKey)}
                                        className={`w-full rounded-md border px-3 py-2 text-left text-xs disabled:opacity-50 ${recoveryKey === entry.objectKey ? 'border-brand bg-brand/10' : 'border-glass-border hover:bg-muted/50'}`}
                                    >
                                        <span className="font-mono block truncate">{entry.objectKey.split('/').pop()}</span>
                                        <span className="text-[10px] text-stat-subtitle font-mono">
                                            {formatBytes(entry.sizeBytes)} {entry.lastModified ? `· ${new Date(entry.lastModified).toLocaleString()}` : ''}
                                            {entry.encrypted ? '' : ' · not encrypted'}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {recoveryTruncated && (
                        <p className="text-xs text-warning">
                            The list stopped at the first 10,000 archives. Use your bucket console to find one that is not listed.
                        </p>
                    )}
                    <div className="space-y-1.5">
                        <Label htmlFor="recovery-passphrase" className="text-sm">Passphrase for this archive</Label>
                        <Input
                            id="recovery-passphrase"
                            type="password"
                            autoComplete="current-password"
                            value={recoveryPassphrase}
                            onChange={e => {
                                setRecoveryPassphrase(e.target.value);
                                if (recoveryError) setRecoveryError('');
                            }}
                        />
                    </div>
                </ModalBody>
                <ModalFooter
                    secondary={<Button variant="outline" onClick={() => setRecoveryOpen(false)} disabled={recoveryBusy}>Cancel</Button>}
                    primary={(
                        <BusyButton
                            pending={recoveryBusy}
                            busyLabel="Recovering"
                            disabled={!recoveryKey}
                            onClick={handleRecover}
                        >
                            Recover
                        </BusyButton>
                    )}
                />
            </Modal>
        </div>
    );
}
