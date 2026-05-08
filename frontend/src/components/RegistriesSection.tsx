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
import { AdmiralGate } from './AdmiralGate';
import { CapabilityGate } from './CapabilityGate';
import { Database, Plus, Trash2, Pencil, RefreshCw, CheckCircle, XCircle, Clock, Zap } from 'lucide-react';
import { SettingsPrimaryButton } from './settings/SettingsActions';
import { SettingsCallout } from './settings/SettingsCallout';
import { useMastheadStats } from './settings/MastheadStatsContext';

type RegistryType = 'dockerhub' | 'ghcr' | 'ecr' | 'custom';

interface RegistryItem {
    id: number;
    name: string;
    url: string;
    type: RegistryType;
    username: string;
    has_secret: boolean;
    aws_region: string | null;
    created_at: number;
    updated_at: number;
}

interface ApiError {
    error?: string;
    message?: string;
    data?: { error?: string };
}

const TYPE_OPTIONS: { value: RegistryType; label: string }[] = [
    { value: 'dockerhub', label: 'Docker Hub' },
    { value: 'ghcr', label: 'GitHub Container Registry (GHCR)' },
    { value: 'ecr', label: 'AWS Elastic Container Registry (ECR)' },
    { value: 'custom', label: 'Custom / Self-hosted' },
];

const TYPE_LABELS: Record<RegistryType, string> = {
    dockerhub: 'Docker Hub',
    ghcr: 'GitHub (GHCR)',
    ecr: 'AWS ECR',
    custom: 'Custom',
};

const TYPE_BADGE_VARIANT: Record<RegistryType, 'default' | 'secondary' | 'outline'> = {
    dockerhub: 'default',
    ghcr: 'secondary',
    ecr: 'secondary',
    custom: 'outline',
};

const TYPE_URL_DEFAULTS: Record<RegistryType, string> = {
    dockerhub: 'https://index.docker.io/v1/',
    ghcr: 'ghcr.io',
    ecr: '',
    custom: '',
};

const TYPE_USERNAME_HINT: Record<RegistryType, string> = {
    dockerhub: 'Docker Hub username',
    ghcr: 'GitHub username',
    ecr: 'AWS Access Key ID',
    custom: 'Username',
};

const TYPE_SECRET_HINT: Record<RegistryType, string> = {
    dockerhub: 'Access token or password',
    ghcr: 'Personal access token (PAT)',
    ecr: 'AWS Secret Access Key',
    custom: 'Password or token',
};

/** Defensive toast chain per CLAUDE.md Directive 6. */
function toastError(e: unknown, fallback: string): void {
    const err = e as ApiError | undefined;
    toast.error(err?.message || err?.error || err?.data?.error || fallback);
}

function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RegistriesSection() {
    const [registries, setRegistries] = useState<RegistryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [testingId, setTestingId] = useState<number | null>(null);
    const [testingForm, setTestingForm] = useState(false);
    const [deleteRegistry, setDeleteRegistry] = useState<RegistryItem | null>(null);

    const [formName, setFormName] = useState('');
    const [formUrl, setFormUrl] = useState('');
    const [formType, setFormType] = useState<RegistryType>('dockerhub');
    const [formUsername, setFormUsername] = useState('');
    const [formSecret, setFormSecret] = useState('');
    const [formAwsRegion, setFormAwsRegion] = useState('');

    const fetchRegistries = async () => {
        try {
            const res = await apiFetch('/registries', { localOnly: true });
            if (res.ok) {
                setRegistries(await res.json());
            }
        } catch {
            toast.error('Failed to load registries.');
        } finally {
            setLoading(false);
        }
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchRegistries(); }, []);

    useMastheadStats(
        loading
            ? null
            : [
                { label: 'REGISTRIES', value: `${registries.length}` },
            ],
    );

    const resetForm = () => {
        setFormName('');
        setFormUrl('');
        setFormType('dockerhub');
        setFormUsername('');
        setFormSecret('');
        setFormAwsRegion('');
        setEditingId(null);
        setShowForm(false);
    };

    const handleTypeChange = (type: RegistryType) => {
        setFormType(type);
        if (!editingId) {
            setFormUrl(TYPE_URL_DEFAULTS[type]);
        }
    };

    const startEdit = (reg: RegistryItem) => {
        setEditingId(reg.id);
        setFormName(reg.name);
        setFormUrl(reg.url);
        setFormType(reg.type);
        setFormUsername(reg.username);
        setFormSecret('');
        setFormAwsRegion(reg.aws_region ?? '');
        setShowForm(true);
    };

    const validateForm = (): boolean => {
        if (!formName.trim()) { toast.error('Name is required.'); return false; }
        if (!formUrl.trim()) { toast.error('URL is required.'); return false; }
        if (!formUsername.trim()) { toast.error('Username is required.'); return false; }
        if (!editingId && !formSecret.trim()) { toast.error('Secret/token is required.'); return false; }
        if (formType === 'ecr' && !formAwsRegion.trim()) { toast.error('AWS region is required for ECR.'); return false; }
        return true;
    };

    const handleTestForm = async () => {
        // Stateless test requires a secret; on edit, user must re-enter it.
        if (!formUrl.trim() || !formUsername.trim() || !formSecret.trim()) {
            toast.error('Fill URL, username, and secret to test.');
            return;
        }
        if (formType === 'ecr' && !formAwsRegion.trim()) {
            toast.error('AWS region is required for ECR.');
            return;
        }
        setTestingForm(true);
        try {
            const res = await apiFetch('/registries/test', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({
                    type: formType,
                    url: formUrl.trim(),
                    username: formUsername.trim(),
                    secret: formSecret.trim(),
                    aws_region: formType === 'ecr' ? formAwsRegion.trim() : null,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success) {
                    toast.success('Connection successful.');
                } else {
                    toast.error(data.error || 'Connection failed.');
                }
            } else {
                const err = await res.json().catch(() => ({}));
                toastError(err, 'Test failed.');
            }
        } catch (e) {
            toastError(e, 'Network error.');
        } finally {
            setTestingForm(false);
        }
    };

    const handleSave = async () => {
        if (!validateForm()) return;

        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                name: formName.trim(),
                url: formUrl.trim(),
                type: formType,
                username: formUsername.trim(),
                aws_region: formType === 'ecr' ? formAwsRegion.trim() : null,
            };
            if (formSecret.trim()) body.secret = formSecret.trim();

            const url = editingId ? `/registries/${editingId}` : '/registries';
            const method = editingId ? 'PUT' : 'POST';

            const res = await apiFetch(url, {
                method,
                localOnly: true,
                body: JSON.stringify(body),
            });

            if (res.ok) {
                toast.success(editingId ? 'Registry updated.' : 'Registry added.');
                resetForm();
                fetchRegistries();
            } else {
                const err = await res.json().catch(() => ({}));
                toastError(err, 'Failed to save registry.');
            }
        } catch (e) {
            toastError(e, 'Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await apiFetch(`/registries/${id}`, { method: 'DELETE', localOnly: true });
            if (res.ok) {
                toast.success('Registry deleted.');
                fetchRegistries();
            } else {
                const err = await res.json().catch(() => ({}));
                toastError(err, 'Failed to delete registry.');
            }
        } catch (e) {
            toastError(e, 'Network error.');
        }
    };

    const handleTest = async (id: number) => {
        setTestingId(id);
        try {
            const res = await apiFetch(`/registries/${id}/test`, { method: 'POST', localOnly: true });
            if (res.ok) {
                const data = await res.json();
                if (data.success) {
                    toast.success('Connection successful.');
                } else {
                    toast.error(data.error || 'Connection failed.');
                }
            } else {
                const err = await res.json().catch(() => ({}));
                toastError(err, 'Test failed.');
            }
        } catch (e) {
            toastError(e, 'Network error.');
        } finally {
            setTestingId(null);
        }
    };

    return (
        <AdmiralGate>
          <CapabilityGate capability="registries" featureName="Private Registries">
            <div className="space-y-6">
                <div className="flex justify-end">
                    <SettingsPrimaryButton size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
                        <Plus className="w-4 h-4" strokeWidth={1.5} /> Add registry
                    </SettingsPrimaryButton>
                </div>

                {/* Create / Edit form */}
                {showForm && (
                    <div className="space-y-4 p-4 rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
                        <div className="space-y-2">
                            <Label>Registry Type</Label>
                            <Combobox
                                options={TYPE_OPTIONS}
                                value={formType}
                                onValueChange={(v) => handleTypeChange(v as RegistryType)}
                                placeholder="Select a registry type"
                                searchPlaceholder="Search types..."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Name</Label>
                            <Input
                                placeholder="My private registry"
                                value={formName}
                                onChange={e => setFormName(e.target.value)}
                                maxLength={100}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Registry URL</Label>
                            <Input
                                placeholder={formType === 'ecr' ? '123456789.dkr.ecr.us-east-1.amazonaws.com' : 'registry.example.com'}
                                value={formUrl}
                                onChange={e => setFormUrl(e.target.value)}
                                maxLength={500}
                                disabled={formType === 'dockerhub'}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>{formType === 'ecr' ? 'AWS Access Key ID' : 'Username'}</Label>
                                <Input
                                    placeholder={TYPE_USERNAME_HINT[formType]}
                                    value={formUsername}
                                    onChange={e => setFormUsername(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>{formType === 'ecr' ? 'AWS Secret Access Key' : 'Secret / Token'}</Label>
                                <Input
                                    type="password"
                                    placeholder={editingId ? '(leave blank to keep current)' : TYPE_SECRET_HINT[formType]}
                                    value={formSecret}
                                    onChange={e => setFormSecret(e.target.value)}
                                />
                            </div>
                        </div>
                        {formType === 'ecr' && (
                            <div className="space-y-2">
                                <Label>AWS Region</Label>
                                <Input
                                    placeholder="us-east-1"
                                    value={formAwsRegion}
                                    onChange={e => setFormAwsRegion(e.target.value)}
                                />
                            </div>
                        )}
                        <div className="flex justify-between items-center gap-2 pt-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleTestForm}
                                disabled={testingForm || saving}
                            >
                                {testingForm ? (
                                    <><RefreshCw className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />Testing...</>
                                ) : (
                                    <><Zap className="w-4 h-4 mr-1.5" strokeWidth={1.5} />Test connection</>
                                )}
                            </Button>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
                                <SettingsPrimaryButton size="sm" onClick={handleSave} disabled={saving}>
                                    {saving ? (
                                        <><RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.5} />Saving</>
                                    ) : editingId ? 'Update' : 'Add'}
                                </SettingsPrimaryButton>
                            </div>
                        </div>
                    </div>
                )}

                {/* Loading state */}
                {loading && (
                    <div className="space-y-3">
                        <Skeleton className="h-20 w-full rounded-lg" />
                        <Skeleton className="h-20 w-full rounded-lg" />
                    </div>
                )}

                {/* Empty state */}
                {!loading && registries.length === 0 && !showForm && (
                    <SettingsCallout
                        icon={<Database className="h-4 w-4" strokeWidth={1.5} />}
                        title="No private registries configured"
                        subtitle="Add one to pull images from Docker Hub orgs, GHCR, ECR, or self-hosted registries."
                    />
                )}

                {/* Registry list */}
                {!loading && registries.map(reg => (
                    <div key={reg.id} className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors hover:border-t-card-border-hover p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                                <Database className="w-4 h-4 text-stat-icon shrink-0" strokeWidth={1.5} />
                                <span className="font-medium text-sm truncate">{reg.name}</span>
                                <Badge variant={TYPE_BADGE_VARIANT[reg.type]} className="text-[10px] shrink-0">
                                    {TYPE_LABELS[reg.type]}
                                </Badge>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleTest(reg.id)}
                                    disabled={testingId === reg.id}
                                    title="Test connection"
                                >
                                    {testingId === reg.id ? (
                                        <RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                                    ) : (
                                        <CheckCircle className="w-4 h-4" strokeWidth={1.5} />
                                    )}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => startEdit(reg)} title="Edit">
                                    <Pencil className="w-4 h-4" strokeWidth={1.5} />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                                    title="Delete"
                                    onClick={() => setDeleteRegistry(reg)}
                                >
                                    <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                                </Button>
                            </div>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-stat-subtitle">
                            <span className="font-mono truncate max-w-[200px]" title={reg.url}>{reg.url}</span>
                            <span>{reg.username}</span>
                            <span className="flex items-center gap-1">
                                {reg.has_secret ? (
                                    <><CheckCircle className="w-3 h-3 text-success" strokeWidth={1.5} /> Secret stored</>
                                ) : (
                                    <><XCircle className="w-3 h-3 text-destructive" strokeWidth={1.5} /> No secret</>
                                )}
                            </span>
                            {reg.aws_region && <span>Region: {reg.aws_region}</span>}
                            <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" strokeWidth={1.5} />
                                {formatDate(reg.created_at)}
                            </span>
                        </div>
                    </div>
                ))}

                <ConfirmModal
                    open={deleteRegistry !== null}
                    onOpenChange={(open) => { if (!open) setDeleteRegistry(null); }}
                    variant="destructive"
                    kicker="REGISTRY · DELETE · IRREVERSIBLE"
                    title="Delete registry"
                    confirmLabel="Delete"
                    onConfirm={() => {
                        if (deleteRegistry) {
                            const id = deleteRegistry.id;
                            setDeleteRegistry(null);
                            handleDelete(id);
                        }
                    }}
                >
                    <p className="text-sm text-stat-subtitle">
                        Removes <span className="font-medium text-stat-value">{deleteRegistry?.name}</span> and its stored credentials. Stacks using images from this registry will fail to pull until credentials are re-added.
                    </p>
                </ConfirmModal>
            </div>
          </CapabilityGate>
        </AdmiralGate>
    );
}
