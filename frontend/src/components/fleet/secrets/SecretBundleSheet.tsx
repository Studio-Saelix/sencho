import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, Copy, Loader2, Download } from 'lucide-react';
import { SystemSheet, SheetSection, type SystemSheetTab } from '@/components/ui/system-sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import {
    type SecretSummary,
    type SecretVersionSummary,
    createSecret,
    updateSecret,
    getSecret,
    listSecretVersions,
    importFromStack,
} from '@/lib/secretsApi';
import { copyToClipboard } from '@/lib/clipboard';

interface KvRow { id: string; key: string; value: string; reveal: boolean }
type Mode = 'create' | 'edit';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When provided, edit existing bundle; when null, create new. */
    secret: SecretSummary | null;
    onSaved: () => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}[a-zA-Z0-9]$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function makeRowId(): string {
    return `r-${Math.random().toString(36).slice(2, 10)}`;
}

function kvToRows(kv: Record<string, string>): KvRow[] {
    return Object.keys(kv)
        .sort()
        .map((key) => ({ id: makeRowId(), key, value: kv[key], reveal: false }));
}

function rowsToKv(rows: KvRow[]): { kv: Record<string, string> } | { error: string } {
    const kv: Record<string, string> = {};
    const seen = new Set<string>();
    for (const r of rows) {
        const k = r.key.trim();
        if (!k) continue;
        if (!KEY_PATTERN.test(k)) {
            return { error: `Invalid key: ${k}` };
        }
        if (seen.has(k)) {
            return { error: `Duplicate key: ${k}` };
        }
        seen.add(k);
        kv[k] = r.value;
    }
    return { kv };
}

export function SecretBundleSheet({ open, onOpenChange, secret, onSaved }: Props) {
    const mode: Mode = secret ? 'edit' : 'create';
    const { nodes } = useNodes();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [rows, setRows] = useState<KvRow[]>([]);
    const [note, setNote] = useState('');
    const [activeTab, setActiveTab] = useState('keys');
    const [submitting, setSubmitting] = useState(false);
    const [loading, setLoading] = useState(false);
    const [versions, setVersions] = useState<SecretVersionSummary[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [importNodeId, setImportNodeId] = useState<number | null>(null);
    const [importStackName, setImportStackName] = useState('');
    const [importEnvFile, setImportEnvFile] = useState('.env');
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        if (secret) {
            setLoading(true);
            (async () => {
                try {
                    const fresh = await getSecret(secret.id);
                    if (cancelled) return;
                    setName(fresh.name);
                    setDescription(fresh.description);
                    setRows(kvToRows(fresh.kv));
                    setNote('');
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Failed to load secret');
                } finally {
                    if (!cancelled) setLoading(false);
                }
            })();
        } else {
            setName('');
            setDescription('');
            setRows([{ id: makeRowId(), key: '', value: '', reveal: true }]);
            setNote('');
            setActiveTab('keys');
        }
        setImportOpen(false);
        setImportNodeId(null);
        setImportStackName('');
        setImportEnvFile('.env');
        return () => { cancelled = true; };
    }, [open, secret]);

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

    const tabs: SystemSheetTab[] = mode === 'edit'
        ? [{ id: 'keys', label: 'Keys', count: rows.filter(r => r.key.trim().length > 0).length }, { id: 'versions', label: 'Versions' }]
        : [{ id: 'keys', label: 'Keys', count: rows.filter(r => r.key.trim().length > 0).length }];

    const canSubmit = useMemo(() => {
        if (!NAME_PATTERN.test(name)) return false;
        if (rows.some(r => r.key.trim().length === 0 && r.value.length > 0)) return false;
        return true;
    }, [name, rows]);

    async function handleSave() {
        if (mode === 'create' && !NAME_PATTERN.test(name)) {
            toast.error('Name must be 2-64 characters (letters, digits, dot, dash, underscore)');
            return;
        }
        const built = rowsToKv(rows);
        if ('error' in built) {
            toast.error(built.error);
            return;
        }
        setSubmitting(true);
        try {
            if (mode === 'create') {
                const result = await createSecret({ name, description: description || undefined, kv: built.kv, note: note || undefined });
                toast.success(`Bundle saved (v${result.version})`);
            } else if (secret) {
                const result = await updateSecret(secret.id, { description, kv: built.kv, note: note || undefined });
                toast.success(`Bundle saved (v${result.version})`);
            }
            onSaved();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save bundle');
        } finally {
            setSubmitting(false);
        }
    }

    function addRow() {
        setRows((prev) => [...prev, { id: makeRowId(), key: '', value: '', reveal: true }]);
    }

    function removeRow(id: string) {
        setRows((prev) => prev.filter(r => r.id !== id));
    }

    function updateRow(id: string, patch: Partial<KvRow>) {
        setRows((prev) => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    }

    async function handleCopyValue(value: string) {
        try {
            await copyToClipboard(value);
            toast.success('Copied');
        } catch {
            toast.error('Copy failed');
        }
    }

    async function handleImportFromStack() {
        if (!secret) return;
        if (importNodeId === null) {
            toast.error('Pick a node');
            return;
        }
        const stackName = importStackName.trim();
        if (!stackName) {
            toast.error('Stack name is required');
            return;
        }
        const envFile = importEnvFile.trim() || '.env';
        const nodeId = importNodeId;
        setImporting(true);
        try {
            const { kv } = await importFromStack(secret.id, {
                nodeId,
                stackName,
                envFileBasename: envFile,
            });
            const incomingKeys = Object.keys(kv);
            if (incomingKeys.length === 0) {
                toast.error(`No keys found in ${envFile} on the selected stack`);
                return;
            }
            setRows((prev) => {
                const incomingSet = new Set(incomingKeys);
                const seenInRows = new Set<string>();
                const next = prev.map((r) => {
                    const k = r.key.trim();
                    if (k) seenInRows.add(k);
                    return k && incomingSet.has(k) ? { ...r, value: kv[k] } : r;
                });
                for (const k of incomingKeys) {
                    if (!seenInRows.has(k)) {
                        next.push({ id: makeRowId(), key: k, value: kv[k], reveal: false });
                    }
                }
                return next;
            });
            const nodeName = nodes.find((n) => n.id === nodeId)?.name ?? `node ${nodeId}`;
            toast.success(`Imported ${incomingKeys.length} ${incomingKeys.length === 1 ? 'key' : 'keys'} from ${nodeName}/${stackName}`);
            setImportOpen(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to import env from stack');
        } finally {
            setImporting(false);
        }
    }

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Secrets', mode === 'create' ? 'New bundle' : (secret?.name ?? 'Bundle')]}
            name={mode === 'create' ? 'New secret bundle' : (secret?.name ?? 'Bundle')}
            meta={mode === 'edit' && secret ? `v${secret.currentVersion} · ${secret.keyCount} keys` : undefined}
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

                            <SheetSection title={`Key/value pairs · ${rows.filter(r => r.key.trim().length > 0).length}`}>
                                <div className="space-y-2">
                                    {rows.map((row) => (
                                        <div key={row.id} className="flex items-start gap-2">
                                            <Input
                                                value={row.key}
                                                onChange={(e) => updateRow(row.id, { key: e.target.value })}
                                                placeholder="KEY_NAME"
                                                className="font-mono w-[200px]"
                                            />
                                            <span className="text-stat-subtitle pt-2">=</span>
                                            <Input
                                                type={row.reveal ? 'text' : 'password'}
                                                value={row.value}
                                                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                                placeholder="value"
                                                className="font-mono flex-1"
                                            />
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => updateRow(row.id, { reveal: !row.reveal })}
                                                aria-label={row.reveal ? 'Hide value' : 'Show value'}
                                            >
                                                {row.reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => void handleCopyValue(row.value)}
                                                aria-label="Copy value"
                                                disabled={!row.value}
                                            >
                                                <Copy className="w-4 h-4" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => removeRow(row.id)}
                                                aria-label="Remove row"
                                            >
                                                <Trash2 className="w-4 h-4 text-destructive/70" />
                                            </Button>
                                        </div>
                                    ))}
                                    <div className="flex items-center gap-2">
                                        <Button type="button" variant="outline" size="sm" onClick={addRow} className="gap-1.5">
                                            <Plus className="w-3.5 h-3.5" /> Add key
                                        </Button>
                                        {mode === 'edit' && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setImportOpen((v) => !v)}
                                                className="gap-1.5"
                                                aria-expanded={importOpen}
                                                aria-controls="import-from-stack-panel"
                                            >
                                                <Download className="w-3.5 h-3.5" /> Import from stack
                                            </Button>
                                        )}
                                    </div>
                                    {mode === 'edit' && importOpen && (
                                        <div id="import-from-stack-panel" className="rounded border border-card-border/60 bg-popover/40 p-3 space-y-3">
                                            <p className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                                Read an env file from a deployed stack · existing keys overlay, new keys append
                                            </p>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                                <div className="space-y-1">
                                                    <label htmlFor="import-node" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Node</label>
                                                    <select
                                                        id="import-node"
                                                        value={importNodeId === null ? '' : String(importNodeId)}
                                                        onChange={(e) => setImportNodeId(e.target.value === '' ? null : Number(e.target.value))}
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
                                                        onChange={(e) => setImportStackName(e.target.value)}
                                                        placeholder="my-app"
                                                        className="font-mono"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label htmlFor="import-envfile" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Env file</label>
                                                    <Input
                                                        id="import-envfile"
                                                        value={importEnvFile}
                                                        onChange={(e) => setImportEnvFile(e.target.value)}
                                                        placeholder=".env"
                                                        className="font-mono"
                                                    />
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-end gap-2">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setImportOpen(false)}
                                                    disabled={importing}
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => void handleImportFromStack()}
                                                    disabled={importing || importNodeId === null || !importStackName.trim()}
                                                    className="gap-1.5"
                                                >
                                                    {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                                    {importing ? 'Importing…' : 'Import'}
                                                </Button>
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
