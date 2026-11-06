import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, Copy, Loader2, Download, Undo2, ShieldAlert } from 'lucide-react';
import { SystemSheet, SheetSection, type SystemSheetTab } from '@/components/ui/system-sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import {
    type SecretSummary,
    type SecretKeyEntry,
    type SecretVersionSummary,
    type SecretPatchOp,
    type SecretImportPreview,
    createSecret,
    patchSecret,
    getSecret,
    listSecretVersions,
    revealValue,
    previewImport,
    applyImport,
} from '@/lib/secretsApi';
import { copyToClipboard } from '@/lib/clipboard';

interface KvRow {
    id: string;
    /** The key as stored, or null for a row the operator is adding. */
    originalKey: string | null;
    key: string;
    /**
     * Typed or revealed value. Empty always means "leave the stored value
     * alone", so clearing a field never erases a credential.
     */
    value: string;
    /** The operator typed a non-empty replacement, so Save sends a `set` op. */
    dirty: boolean;
    /** An original row the operator asked to remove, kept visible for undo. */
    deleted: boolean;
    /** Epoch ms until a revealed value stops being shown, or null. */
    revealedUntil: number | null;
    /** The server's mask for this key, used as the placeholder. */
    masked: string | null;
    /** A row the operator typed, hidden with the local eye toggle. */
    hidden: boolean;
}

type Mode = 'create' | 'edit';

interface ImportInput {
    nodeId: number;
    stackName: string;
    envFileBasename: string;
}

/** The import needs the editor clean: an import writes a version and reloads the rows. */
function hasUnsavedEdits(ops: unknown[], descriptionChanged: boolean): boolean {
    return ops.length > 0 || descriptionChanged;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When provided, edit existing bundle; when null, create new. */
    secret: SecretSummary | null;
    onSaved: () => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}[a-zA-Z0-9]$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MASK = '••••••••';

function makeRowId(): string {
    return `r-${Math.random().toString(36).slice(2, 10)}`;
}

function maskToRow(entry: SecretKeyEntry): KvRow {
    return {
        id: makeRowId(),
        originalKey: entry.key,
        key: entry.key,
        value: '',
        dirty: false,
        deleted: false,
        revealedUntil: null,
        masked: entry.masked,
        hidden: false,
    };
}

function newRow(): KvRow {
    return {
        id: makeRowId(),
        originalKey: null,
        key: '',
        value: '',
        dirty: false,
        deleted: false,
        revealedUntil: null,
        masked: null,
        hidden: false,
    };
}

/**
 * Collapse the editor into per-key operations. Untouched rows contribute
 * nothing (their stored value stays), a renamed row carries its value across
 * without a reveal, and blank or duplicate rows are skipped.
 */
function buildOps(rows: KvRow[]): SecretPatchOp[] {
    const ops: SecretPatchOp[] = [];
    const kept = new Set<string>();
    for (const row of rows) {
        const key = row.key.trim();
        if (row.deleted) {
            if (row.originalKey) ops.push({ op: 'remove', key: row.originalKey });
            continue;
        }
        if (!key || kept.has(key)) continue;
        kept.add(key);
        if (row.originalKey === null) {
            ops.push({ op: 'set', key, value: row.value });
            continue;
        }
        if (key !== row.originalKey) ops.push({ op: 'rename', from: row.originalKey, to: key });
        if (row.dirty && row.value.length > 0) ops.push({ op: 'set', key, value: row.value });
    }
    return ops;
}

function validateRows(rows: KvRow[]): string | null {
    const liveRows = rows.filter(r => !r.deleted && r.key.trim().length > 0);
    if (rows.some(r => !r.deleted && r.key.trim().length === 0 && r.value.length > 0)) {
        return 'Every value needs a key';
    }
    const seen = new Set<string>();
    for (const row of liveRows) {
        const key = row.key.trim();
        if (!KEY_PATTERN.test(key)) return `Invalid key: ${key}`;
        if (seen.has(key)) return `Duplicate key: ${key}`;
        seen.add(key);
    }
    return null;
}

function secondsLeft(until: number, now: number): number {
    return Math.max(0, Math.ceil((until - now) / 1000));
}

export function SecretBundleSheet({ open, onOpenChange, secret, onSaved }: Props) {
    const mode: Mode = secret ? 'edit' : 'create';
    const { nodes } = useNodes();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [loadedDescription, setLoadedDescription] = useState('');
    const [expectedVersion, setExpectedVersion] = useState(1);
    const [rows, setRows] = useState<KvRow[]>([]);
    const [note, setNote] = useState('');
    const [activeTab, setActiveTab] = useState('keys');
    const [submitting, setSubmitting] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [revealing, setRevealing] = useState<Set<string>>(new Set());
    const [now, setNow] = useState(() => Date.now());
    const [versions, setVersions] = useState<SecretVersionSummary[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [importNodeId, setImportNodeId] = useState<number | null>(null);
    const [importStackName, setImportStackName] = useState('');
    const [importEnvFile, setImportEnvFile] = useState('.env');
    const [importPreview, setImportPreview] = useState<{ preview: SecretImportPreview; input: ImportInput } | null>(null);
    const [importBusy, setImportBusy] = useState(false);
    // Every async load carries a token: a response for a sheet that has since
    // closed or switched bundles is dropped instead of filling the editor.
    const loadTokenRef = useRef(0);
    const importTokenRef = useRef(0);
    // The bundle the sheet is open for right now. A reload triggered by a save
    // or import conflict must not fill the editor after the operator moved on.
    const openSecretIdRef = useRef<number | null>(null);

    const loadDetail = useCallback(async (id: number) => {
        if (openSecretIdRef.current !== id) return;
        const token = ++loadTokenRef.current;
        setLoading(true);
        setLoadError(null);
        try {
            const fresh = await getSecret(id);
            if (loadTokenRef.current !== token || openSecretIdRef.current !== id) return;
            setName(fresh.name);
            setDescription(fresh.description);
            setLoadedDescription(fresh.description);
            setExpectedVersion(fresh.currentVersion);
            setRows(fresh.keys.map(maskToRow));
            setNote('');
            importTokenRef.current += 1;
            setImportPreview(null);
        } catch (err) {
            if (loadTokenRef.current !== token || openSecretIdRef.current !== id) return;
            const message = err instanceof Error ? err.message : 'Failed to load secret';
            setLoadError(message);
            toast.error(message);
        } finally {
            if (loadTokenRef.current === token) setLoading(false);
        }
    }, []);

    useEffect(() => {
        openSecretIdRef.current = open && secret ? secret.id : null;
        if (!open) {
            // Drop any in-flight detail load; the sheet state must not change
            // after it closes.
            loadTokenRef.current += 1;
            setLoading(false);
            setLoadError(null);
            return;
        }
        if (secret) {
            void loadDetail(secret.id);
        } else {
            loadTokenRef.current += 1;
            setLoading(false);
            setLoadError(null);
            setName('');
            setDescription('');
            setLoadedDescription('');
            setExpectedVersion(1);
            setRows([newRow()]);
            setNote('');
            setActiveTab('keys');
        }
        importTokenRef.current += 1;
        setImportOpen(false);
        setImportNodeId(null);
        setImportStackName('');
        setImportEnvFile('.env');
        setImportPreview(null);
    }, [open, secret, loadDetail]);

    useEffect(() => {
        if (!open || !secret || activeTab !== 'versions') return;
        let cancelled = false;
        setVersionsLoading(true);
        (async () => {
            try {
                const list = await listSecretVersions(secret.id);
                if (!cancelled) setVersions(list);
            } catch (err) {
                if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load versions');
            } finally {
                if (!cancelled) setVersionsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, secret, activeTab]);

    // One ticker drives every countdown; revealed values are dropped the moment
    // their window closes, so nothing lingers in the editor.
    const hasLiveReveal = rows.some(r => r.revealedUntil !== null);
    useEffect(() => {
        if (!hasLiveReveal) return;
        const timer = window.setInterval(() => {
            const at = Date.now();
            setNow(at);
            setRows(prev => prev.map(r => (r.revealedUntil !== null && r.revealedUntil <= at
                ? { ...r, value: '', dirty: false, revealedUntil: null }
                : r)));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [hasLiveReveal]);

    const tabs: SystemSheetTab[] = mode === 'edit'
        ? [{ id: 'keys', label: 'Keys', count: rows.filter(r => !r.deleted && r.key.trim().length > 0).length }, { id: 'versions', label: 'Versions' }]
        : [{ id: 'keys', label: 'Keys', count: rows.filter(r => r.key.trim().length > 0).length }];

    const rowError = useMemo(() => validateRows(rows), [rows]);
    const ops = useMemo(() => buildOps(rows), [rows]);
    const descriptionChanged = description !== loadedDescription;

    const canSubmit = useMemo(() => {
        if (rowError) return false;
        if (mode === 'create') return NAME_PATTERN.test(name);
        return ops.length > 0 || descriptionChanged;
    }, [rowError, mode, name, ops, descriptionChanged]);

    async function handleSave() {
        if (rowError) {
            toast.error(rowError);
            return;
        }
        if (mode === 'create') {
            if (!NAME_PATTERN.test(name)) {
                toast.error('Name must be 2-64 characters (letters, digits, dot, dash, underscore)');
                return;
            }
            const kv: Record<string, string> = {};
            for (const row of rows) {
                const key = row.key.trim();
                if (key) kv[key] = row.value;
            }
            setSubmitting(true);
            try {
                const result = await createSecret({ name, description: description || undefined, kv, note: note || undefined });
                toast.success(`Bundle saved (v${result.version})`);
                onSaved();
                onOpenChange(false);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to save bundle');
            } finally {
                setSubmitting(false);
            }
            return;
        }
        if (!secret) return;
        setSubmitting(true);
        try {
            const result = await patchSecret(secret.id, {
                expectedVersion,
                ops,
                description: descriptionChanged ? description : undefined,
                note: note || undefined,
            });
            toast.success(result.version === expectedVersion
                ? 'Bundle metadata saved'
                : `Bundle saved (v${result.version})`);
            onSaved();
            onOpenChange(false);
        } catch (err) {
            const conflict = err instanceof Error
                && (err as Error & { status?: number }).status === 409;
            if (conflict) {
                toast.error('This bundle changed since you opened it. Reloading the current version.');
                await loadDetail(secret.id);
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to save bundle');
            }
        } finally {
            setSubmitting(false);
        }
    }

    function addRow() {
        setRows((prev) => [...prev, newRow()]);
    }

    function removeNewRow(id: string) {
        setRows((prev) => prev.filter(r => r.id !== id));
    }

    function markDeleted(id: string, deleted: boolean) {
        setRows((prev) => prev.map(r => (r.id === id
            ? { ...r, deleted, value: '', dirty: false, revealedUntil: null }
            : r)));
    }

    function updateRow(id: string, patch: Partial<KvRow>) {
        setRows((prev) => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    }

    async function handleReveal(row: KvRow) {
        if (!secret) return;
        if (row.dirty) {
            toast.error('This row has an unsaved value. Save it or clear it before revealing.');
            return;
        }
        const token = row.id;
        setRevealing(prev => new Set(prev).add(token));
        try {
            // Reveal the stored key: after an unsaved rename the value still
            // lives under the original key.
            const revealed = await revealValue(secret.id, row.originalKey ?? row.key, expectedVersion);
            setNow(Date.now());
            setRows(prev => prev.map(r => {
                if (r.id === token) {
                    return { ...r, value: revealed.value, dirty: false, revealedUntil: revealed.expiresAt };
                }
                // One value at a time: any other revealed row re-masks.
                return r.revealedUntil === null ? r : { ...r, value: '', dirty: false, revealedUntil: null };
            }));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to reveal value');
        } finally {
            setRevealing(prev => {
                const next = new Set(prev);
                next.delete(token);
                return next;
            });
        }
    }

    function hideRow(row: KvRow) {
        updateRow(row.id, { value: '', dirty: false, revealedUntil: null });
    }

    async function handleCopy(value: string) {
        try {
            await copyToClipboard(value);
            toast.success('Copied');
        } catch {
            toast.error('Copy failed');
        }
    }

    function resetImport() {
        // A new input set invalidates any preview in flight, and that request
        // no longer owns the busy flag.
        importTokenRef.current += 1;
        setImportPreview(null);
        setImportBusy(false);
    }

    function currentImportInput(): ImportInput | null {
        if (importNodeId === null) {
            toast.error('Pick a node');
            return null;
        }
        const stackName = importStackName.trim();
        if (!stackName) {
            toast.error('Stack name is required');
            return null;
        }
        return { nodeId: importNodeId, stackName, envFileBasename: importEnvFile.trim() || '.env' };
    }

    async function handlePreviewImport() {
        if (!secret) return;
        if (hasUnsavedEdits(ops, descriptionChanged)) {
            toast.error('Save or discard your key edits before importing.');
            return;
        }
        const input = currentImportInput();
        if (!input) return;
        const token = ++importTokenRef.current;
        setImportBusy(true);
        try {
            const preview = await previewImport(secret.id, input);
            if (importTokenRef.current !== token) return;
            setImportPreview({ preview, input });
            if (preview.keys.length === 0) toast.info('That env file has no keys to import');
        } catch (err) {
            if (importTokenRef.current !== token) return;
            toast.error(err instanceof Error ? err.message : 'Failed to preview import');
        } finally {
            if (importTokenRef.current === token) setImportBusy(false);
        }
    }

    async function handleApplyImport() {
        if (!secret || !importPreview) return;
        if (hasUnsavedEdits(ops, descriptionChanged)) {
            toast.error('Save or discard your key edits before importing.');
            return;
        }
        setImportBusy(true);
        try {
            // Apply exactly what was previewed, not whatever the fields hold now.
            const result = await applyImport(secret.id, {
                ...importPreview.input,
                expectedVersion,
                expectedFingerprint: importPreview.preview.fingerprint,
                note: note || undefined,
            });
            toast.success(`Imported env into v${result.version}`);
            setImportOpen(false);
            resetImport();
            await loadDetail(secret.id);
            onSaved();
        } catch (err) {
            const apiError = err as Error & { status?: number; code?: string };
            if (apiError.status === 409 && apiError.code === 'IMPORT_SOURCE_CHANGED') {
                // The env file moved, not the bundle: keep the editor as it is
                // and make the operator look at the new source.
                toast.error('The env file changed since you previewed it. Preview again before importing.');
                resetImport();
            } else if (apiError.status === 409) {
                toast.error('This bundle changed since you opened it. Reloading the current version.');
                resetImport();
                await loadDetail(secret.id);
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to import env from stack');
            }
        } finally {
            setImportBusy(false);
        }
    }

    const liveKeys = rows.filter(r => r.key.trim().length > 0).length;

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Secrets', mode === 'create' ? 'New bundle' : (secret?.name ?? 'Bundle')]}
            name={mode === 'create' ? 'New secret bundle' : (secret?.name ?? 'Bundle')}
            meta={mode === 'edit' && secret ? `v${expectedVersion} · ${liveKeys} keys · values masked` : undefined}
            primaryAction={{
                label: submitting ? 'Saving…' : 'Save',
                onClick: handleSave,
                disabled: submitting || loading || !canSubmit,
            }}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            size="lg"
        >
            {activeTab === 'keys' && (
                <div className="space-y-5">
                    {loading ? (
                        <div className="flex items-center gap-2 text-sm text-stat-subtitle"><Loader2 className="w-4 h-4 animate-spin" /> Loading bundle…</div>
                    ) : loadError ? (
                        <div className="rounded border border-destructive/30 bg-destructive/5 p-4 space-y-2">
                            <div className="flex items-center gap-2 text-sm text-destructive">
                                <ShieldAlert className="w-4 h-4" /> {loadError}
                            </div>
                            {secret && (
                                <Button type="button" variant="outline" size="sm" onClick={() => void loadDetail(secret.id)}>
                                    Retry
                                </Button>
                            )}
                        </div>
                    ) : (
                        <>
                            <SheetSection title="Identity">
                                <div className="space-y-3">
                                    <div className="space-y-1">
                                        <label htmlFor="secret-name" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Name</label>
                                        <Input
                                            id="secret-name"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            placeholder="app-secrets"
                                            disabled={mode === 'edit'}
                                            className="font-mono"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label htmlFor="secret-description" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Description</label>
                                        <Input
                                            id="secret-description"
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            placeholder="Production database and API credentials"
                                        />
                                    </div>
                                </div>
                            </SheetSection>

                            <SheetSection title={`Key/value pairs · ${liveKeys}`}>
                                <div className="space-y-2">
                                    {mode === 'edit' && (
                                        <p className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                            Values are masked. Reveal shows one value at a time for a few seconds; typing replaces it, and clearing a field leaves the stored value.
                                        </p>
                                    )}
                                    {rows.map((row) => {
                                        const revealed = row.revealedUntil !== null;
                                        const left = row.revealedUntil !== null ? secondsLeft(row.revealedUntil, now) : 0;
                                        return (
                                            <div
                                                key={row.id}
                                                className={`flex flex-wrap items-center gap-2 ${row.deleted ? 'opacity-50' : ''}`}
                                            >
                                                <Input
                                                    value={row.key}
                                                    onChange={(e) => updateRow(row.id, { key: e.target.value })}
                                                    placeholder="KEY_NAME"
                                                    aria-label="Key"
                                                    disabled={row.deleted}
                                                    className={`font-mono w-[200px] ${row.deleted ? 'line-through' : ''}`}
                                                />
                                                <span className="text-stat-subtitle">=</span>
                                                <div className="flex-1 min-w-[180px] flex items-center gap-2">
                                                    <Input
                                                        type={row.hidden ? 'password' : 'text'}
                                                        value={row.value}
                                                        onChange={(e) => updateRow(row.id, {
                                                            value: e.target.value,
                                                            // Empty means "keep the stored value": clearing a
                                                            // field never erases a credential.
                                                            dirty: e.target.value.length > 0,
                                                            revealedUntil: null,
                                                        })}
                                                        placeholder={row.originalKey !== null ? (row.masked ?? MASK) : 'value'}
                                                        aria-label={row.originalKey !== null ? `Value for ${row.originalKey}` : 'Value'}
                                                        disabled={row.deleted}
                                                        className="font-mono flex-1"
                                                    />
                                                    {revealed && (
                                                        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-amber-500 tabular-nums whitespace-nowrap">
                                                            hides in {left}s
                                                        </span>
                                                    )}
                                                </div>
                                                {row.originalKey !== null && !row.deleted ? (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => (revealed ? hideRow(row) : void handleReveal(row))}
                                                        disabled={revealing.has(row.id) || row.dirty}
                                                        aria-label={revealed ? 'Hide value' : 'Reveal value'}
                                                        title={revealed
                                                            ? 'Hide value'
                                                            : row.dirty
                                                                ? 'Save or clear your edit to reveal the stored value'
                                                                : 'Reveal this value'}
                                                    >
                                                        {revealing.has(row.id)
                                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                                            : revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => updateRow(row.id, { hidden: !row.hidden })}
                                                        disabled={row.deleted}
                                                        aria-label={row.hidden ? 'Show value' : 'Hide value'}
                                                    >
                                                        {row.hidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                                                    </Button>
                                                )}
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => void handleCopy(row.value)}
                                                    aria-label="Copy value"
                                                    disabled={!row.value || row.deleted}
                                                >
                                                    <Copy className="w-4 h-4" />
                                                </Button>
                                                {row.originalKey !== null ? (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => markDeleted(row.id, !row.deleted)}
                                                        aria-label={row.deleted ? 'Keep key' : 'Remove key'}
                                                        title={row.deleted ? 'Keep key' : 'Remove key'}
                                                    >
                                                        {row.deleted
                                                            ? <Undo2 className="w-4 h-4" />
                                                            : <Trash2 className="w-4 h-4 text-destructive/70" />}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => removeNewRow(row.id)}
                                                        aria-label="Remove row"
                                                    >
                                                        <Trash2 className="w-4 h-4 text-destructive/70" />
                                                    </Button>
                                                )}
                                            </div>
                                        );
                                    })}
                                    <div className="flex items-center gap-2">
                                        <Button type="button" variant="outline" size="sm" onClick={addRow} className="gap-1.5">
                                            <Plus className="w-3.5 h-3.5" /> Add key
                                        </Button>
                                        {mode === 'edit' && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => {
                                                    setImportOpen((v) => !v);
                                                    resetImport();
                                                }}
                                                className="gap-1.5"
                                                aria-expanded={importOpen}
                                                aria-controls="import-from-stack-panel"
                                            >
                                                <Download className="w-3.5 h-3.5" /> Import from stack
                                            </Button>
                                        )}
                                    </div>
                                    {rowError && <p className="text-xs text-destructive">{rowError}</p>}
                                    {mode === 'edit' && importOpen && (
                                        <div id="import-from-stack-panel" className="rounded border border-card-border/60 bg-popover/40 p-3 space-y-3">
                                            <p className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                                Read an env file from a deployed stack · previews keys and change classes, saves as a new version
                                            </p>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                                <div className="space-y-1">
                                                    <label htmlFor="import-node" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Node</label>
                                                    <select
                                                        id="import-node"
                                                        value={importNodeId === null ? '' : String(importNodeId)}
                                                        onChange={(e) => {
                                                            setImportNodeId(e.target.value === '' ? null : Number(e.target.value));
                                                            resetImport();
                                                        }}
                                                        className="font-mono text-sm rounded border border-card-border bg-popover/40 px-2 py-1.5 w-full"
                                                    >
                                                        <option value="">Pick a node…</option>
                                                        {nodes.map((n) => (
                                                            <option key={n.id} value={n.id}>{n.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div className="space-y-1">
                                                    <label htmlFor="import-stack" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Stack name</label>
                                                    <Input
                                                        id="import-stack"
                                                        value={importStackName}
                                                        onChange={(e) => {
                                                            setImportStackName(e.target.value);
                                                            resetImport();
                                                        }}
                                                        placeholder="my-app"
                                                        className="font-mono"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label htmlFor="import-envfile" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Env file</label>
                                                    <Input
                                                        id="import-envfile"
                                                        value={importEnvFile}
                                                        onChange={(e) => {
                                                            setImportEnvFile(e.target.value);
                                                            resetImport();
                                                        }}
                                                        placeholder=".env"
                                                        className="font-mono"
                                                    />
                                                </div>
                                            </div>
                                            {importPreview && (
                                                <div className="rounded border border-card-border/60 bg-background/40 p-2 space-y-1">
                                                    <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                                        +{importPreview.preview.added} added · ~{importPreview.preview.changed} changed · {importPreview.preview.unchanged} unchanged
                                                    </div>
                                                    {importPreview.preview.keys.map((entry) => (
                                                        <div key={entry.key} className="flex items-baseline gap-2 font-mono text-xs">
                                                            <span className={`w-16 uppercase tracking-[0.18em] text-[10px] ${entry.status === 'added' ? 'text-emerald-500' : entry.status === 'changed' ? 'text-amber-500' : 'text-stat-subtitle/60'}`}>
                                                                {entry.status}
                                                            </span>
                                                            <span className="flex-1 truncate">{entry.key}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="flex items-center justify-end gap-2">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => { setImportOpen(false); resetImport(); }}
                                                    disabled={importBusy}
                                                >
                                                    Cancel
                                                </Button>
                                                {importPreview === null ? (
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => void handlePreviewImport()}
                                                        disabled={importBusy || importNodeId === null || !importStackName.trim()}
                                                        className="gap-1.5"
                                                    >
                                                        {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                                        {importBusy ? 'Reading…' : 'Preview import'}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => void handleApplyImport()}
                                                        disabled={importBusy || importPreview.preview.keys.length === 0}
                                                        className="gap-1.5"
                                                    >
                                                        {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                                        {importBusy ? 'Importing…' : 'Import & save'}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </SheetSection>

                            <SheetSection title="Change note (optional)">
                                <Input
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder={mode === 'create' ? 'initial bundle' : 'Why this change?'}
                                />
                            </SheetSection>
                        </>
                    )}
                </div>
            )}

            {activeTab === 'versions' && (
                <div className="space-y-2">
                    {versionsLoading && (
                        <div className="flex items-center gap-2 text-sm text-stat-subtitle"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
                    )}
                    {!versionsLoading && versions.length === 0 && (
                        <div className="text-sm text-stat-subtitle">No version history yet.</div>
                    )}
                    {!versionsLoading && versions.map((v) => (
                        <div key={v.version} className="rounded border border-card-border/60 bg-popover/40 px-3 py-2 flex items-baseline gap-3">
                            <div className="font-mono text-sm tabular-nums">v{v.version}</div>
                            <div className="text-xs text-stat-subtitle">{v.keyCount} keys</div>
                            <div className="text-xs text-stat-subtitle flex-1 truncate">{v.note || '(no note)'}</div>
                            <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">{v.createdBy}</div>
                            <div className="text-[10px] font-mono text-stat-subtitle tabular-nums">{new Date(v.createdAt).toLocaleString()}</div>
                        </div>
                    ))}
                </div>
            )}
        </SystemSheet>
    );
}
