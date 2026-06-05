import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Pencil, Send, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { listSecrets, deleteSecret, type SecretSummary } from '@/lib/secretsApi';
import { SecretBundleSheet } from './SecretBundleSheet';
import { SecretPushSheet } from './SecretPushSheet';
import { FleetTabHeading, FleetEmptyState, FleetEmptyCard } from '../FleetEmptyState';

export function SecretsTab() {
    const [items, setItems] = useState<SecretSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editing, setEditing] = useState<SecretSummary | null>(null);
    const [creating, setCreating] = useState(false);
    const [pushing, setPushing] = useState<SecretSummary | null>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const list = await listSecrets();
            setItems(list);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load secrets';
            setLoadError(message);
            toast.error(message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function handleDelete(secret: SecretSummary) {
        if (!confirm(`Delete bundle '${secret.name}'? This removes all versions and push history.`)) return;
        setDeletingId(secret.id);
        try {
            await deleteSecret(secret.id);
            toast.success('Bundle deleted');
            await refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete bundle');
        } finally {
            setDeletingId(null);
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-xs text-stat-subtitle font-mono uppercase tracking-[0.18em]">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Loading secrets…
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="mx-auto max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 p-6 space-y-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">Could not load secrets</div>
                <p className="text-sm text-stat-subtitle leading-relaxed">{loadError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>Retry</Button>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <FleetTabHeading
                title="Secret bundles"
                subtitle="Centralized env-var bundles, encrypted at rest, versioned, pushed to labeled nodes."
                action={
                    <Button type="button" onClick={() => setCreating(true)} className="gap-1.5">
                        <Plus className="w-4 h-4" /> New bundle
                    </Button>
                }
            />

            {items.length === 0 ? (
                <FleetEmptyState>
                    <FleetEmptyCard
                        icon={KeyRound}
                        title="One source of truth for env"
                        description="Build a bundle of key=value pairs, push it to nodes by label, see exactly what changed before you write."
                        action={
                            <Button type="button" onClick={() => setCreating(true)} className="gap-1.5">
                                <Plus className="w-4 h-4" /> Create your first bundle
                            </Button>
                        }
                    />
                </FleetEmptyState>
            ) : (
                <div className="rounded-xl border border-card-border/60 overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-popover/40 border-b border-card-border/60">
                            <tr className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                <th className="px-4 py-2 text-left font-normal">Name</th>
                                <th className="px-4 py-2 text-left font-normal">Description</th>
                                <th className="px-4 py-2 text-right font-normal tabular-nums">Version</th>
                                <th className="px-4 py-2 text-right font-normal tabular-nums">Keys</th>
                                <th className="px-4 py-2 text-left font-normal">Updated</th>
                                <th className="px-4 py-2 text-right font-normal" />
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((s) => (
                                <tr key={s.id} className="border-b border-card-border/30 last:border-b-0 hover:bg-popover/20">
                                    <td className="px-4 py-2 font-mono">{s.name}</td>
                                    <td className="px-4 py-2 text-stat-subtitle truncate max-w-[300px]">{s.description || <span className="text-stat-subtitle/50">·</span>}</td>
                                    <td className="px-4 py-2 text-right font-mono tabular-nums">v{s.currentVersion}</td>
                                    <td className="px-4 py-2 text-right font-mono tabular-nums">{s.keyCount}</td>
                                    <td className="px-4 py-2 font-mono text-xs text-stat-subtitle tabular-nums">{new Date(s.updatedAt).toLocaleString()}</td>
                                    <td className="px-4 py-2">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button type="button" variant="ghost" size="icon" onClick={() => setEditing(s)} aria-label="Edit">
                                                <Pencil className="w-4 h-4" />
                                            </Button>
                                            <Button type="button" variant="ghost" size="icon" onClick={() => setPushing(s)} aria-label="Send">
                                                <Send className="w-4 h-4" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => void handleDelete(s)}
                                                disabled={deletingId === s.id}
                                                aria-label="Delete"
                                            >
                                                <Trash2 className="w-4 h-4 text-destructive/70" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <SecretBundleSheet
                open={creating || editing !== null}
                onOpenChange={(o) => {
                    if (!o) {
                        setCreating(false);
                        setEditing(null);
                    }
                }}
                secret={editing}
                onSaved={() => void refresh()}
            />

            <SecretPushSheet
                open={pushing !== null}
                onOpenChange={(o) => { if (!o) setPushing(null); }}
                secret={pushing}
            />
        </div>
    );
}
