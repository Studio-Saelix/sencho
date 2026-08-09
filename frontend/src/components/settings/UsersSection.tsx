import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TogglePill } from '@/components/ui/toggle-pill';
import { apiFetch } from '@/lib/api';
import { useAuth, type UserRole } from '@/context/AuthContext';
import { CapabilityGate } from '@/components/CapabilityGate';
import { RefreshCw, Trash2, Plus, Pencil, ShieldOff, AlertTriangle } from 'lucide-react';
import { SettingsCallout } from './SettingsCallout';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { DEFAULT_SETTINGS } from './types';

interface UserItem {
    id: number;
    username: string;
    role: UserRole;
    auth_provider: string;
    created_at: number;
    mfaEnabled?: boolean;
}

interface RoleAssignmentItem {
    id: number;
    user_id: number;
    role: UserRole;
    resource_type: 'stack' | 'node';
    resource_id: string;
    node_id: number | null;
    created_at: number;
}

type SlidingRefresh = '0' | '1';

const DEFAULT_SLIDING_REFRESH: SlidingRefresh = DEFAULT_SETTINGS.session_sliding_refresh ?? '1';

function SessionPolicySkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

/**
 * Instance-wide session behavior: whether an actively-used session silently
 * renews itself instead of hard-expiring. Pinned to the local instance via
 * `localOnly: true` on every fetch, like the rest of this page (a frontend
 * convention, not a backend hub-only guard such as registries/secrets have),
 * since it governs sign-in to this instance's own user table, not a remote
 * node's.
 */
function SessionPolicySection() {
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [value, setValue] = useState<SlidingRefresh>(DEFAULT_SLIDING_REFRESH);
    const [saved, setSaved] = useState<SlidingRefresh>(DEFAULT_SLIDING_REFRESH);
    const [isSaving, setIsSaving] = useState(false);
    const hasChanges = value !== saved;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch('/settings', { localOnly: true });
                if (cancelled) return;
                if (!res.ok) {
                    setPhase('error');
                    toast.error('Failed to load session policy.');
                    return;
                }
                const raw = (await res.json())?.session_sliding_refresh;
                if (cancelled) return;
                const loaded: SlidingRefresh = raw === '0' || raw === '1' ? raw : DEFAULT_SLIDING_REFRESH;
                setValue(loaded);
                setSaved(loaded);
                setPhase('ready');
            } catch {
                if (!cancelled) {
                    setPhase('error');
                    toast.error('Failed to load session policy.');
                }
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const saveSettings = async () => {
        // Snapshot the submitted value: the toggle stays live while the PATCH is
        // in flight, so adopting `value` after the await could mark an edit made
        // meanwhile as already saved.
        const submitted = value;
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                localOnly: true,
                body: JSON.stringify({ session_sliding_refresh: submitted }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            setSaved(submitted);
            toast.success('Session policy saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (phase === 'loading') return <SessionPolicySkeleton />;

    if (phase === 'error') {
        return (
            <SettingsCallout
                tone="error"
                icon={<AlertTriangle className="h-4 w-4" />}
                title="Could not load session policy"
                subtitle="The current value could not be confirmed, so editing is unavailable. Reload the page to try again."
            />
        );
    }

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
            <SettingsSection title="Session policy">
                <SettingsField
                    label="Keep active sessions alive"
                    helper="Silently renew a signed-in session while it stays active, instead of hard-expiring it on a fixed schedule. On by default; turn off to enforce a strict session ceiling regardless of activity."
                >
                    <TogglePill
                        checked={value === '1'}
                        onChange={(next) => setValue(next ? '1' : '0')}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? '1 unsaved' : undefined)}>
                {!readOnly && (
                    <SettingsPrimaryButton size="sm" onClick={saveSettings} disabled={isSaving || !hasChanges}>
                        {isSaving ? (
                            <>
                                <RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                                Saving
                            </>
                        ) : (
                            'Save session policy'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
    );
}

export function UsersSection() {
    const { user: currentUser } = useAuth();
    const [users, setUsers] = useState<UserItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingUser, setEditingUser] = useState<UserItem | null>(null);
    const [saving, setSaving] = useState(false);

    // Form state
    const [formUsername, setFormUsername] = useState('');
    const [formPassword, setFormPassword] = useState('');
    const [formConfirmPassword, setFormConfirmPassword] = useState('');
    const [formRole, setFormRole] = useState<UserRole>('viewer');

    // Per-row destructive confirms
    const [resetMfaTarget, setResetMfaTarget] = useState<UserItem | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<UserItem | null>(null);

    const fetchUsers = async () => {
        try {
            const res = await apiFetch('/users', { localOnly: true });
            if (res.ok) setUsers(await res.json());
        } catch { /* ignore */ } finally { setLoading(false); }
    };

    useEffect(() => { fetchUsers(); }, []);

    useMastheadStats(
        loading
            ? null
            : [
                { label: 'OPERATORS', value: `${users.length}` },
            ],
    );

    const resetForm = () => {
        setFormUsername('');
        setFormPassword('');
        setFormConfirmPassword('');
        setFormRole('viewer');
        setEditingUser(null);
        setShowForm(false);
        setRoleAssignments([]);
        setScopeResourceType('stack');
        setScopeNodeId('');
        setScopeResourceId('');
        setAvailableStacks([]);
    };

    const handleSave = async () => {
        if (!formUsername || formUsername.length < 3) {
            toast.error('Username must be at least 3 characters.');
            return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(formUsername)) {
            toast.error('Username can only contain letters, numbers, underscores, and hyphens.');
            return;
        }
        if (!editingUser && !formPassword) {
            toast.error('Password is required for new users.');
            return;
        }
        if (formPassword && formPassword.length < 8) {
            toast.error('Password must be at least 8 characters.');
            return;
        }
        if (formPassword && formPassword !== formConfirmPassword) {
            toast.error('Passwords do not match.');
            return;
        }
        setSaving(true);
        try {
            if (editingUser) {
                const body: Record<string, string> = { username: formUsername, role: formRole };
                if (formPassword) body.password = formPassword;
                const res = await apiFetch(`/users/${editingUser.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    localOnly: true,
                });
                if (!res.ok) {
                    const err = await res.json();
                    toast.error(err?.error || err?.message || 'Failed to update user.');
                    return;
                }
                toast.success('User updated.');
            } else {
                const res = await apiFetch('/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: formUsername, password: formPassword, role: formRole }),
                    localOnly: true,
                });
                if (!res.ok) {
                    const err = await res.json();
                    toast.error(err?.error || err?.message || 'Failed to create user.');
                    return;
                }
                toast.success('User created.');
            }
            resetForm();
            fetchUsers();
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Something went wrong.';
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    const handleResetMfa = async (userId: number, username: string) => {
        try {
            const res = await apiFetch(`/users/${userId}/mfa/reset`, { method: 'POST', localOnly: true });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to reset two-factor authentication.');
                return;
            }
            toast.success(`Two-factor authentication reset for ${username}.`);
            fetchUsers();
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Something went wrong.';
            toast.error(msg);
        }
    };

    const handleDelete = async (userId: number) => {
        try {
            const res = await apiFetch(`/users/${userId}`, { method: 'DELETE', localOnly: true });
            if (!res.ok) {
                const err = await res.json();
                toast.error(err?.error || err?.message || 'Failed to delete user.');
                return;
            }
            toast.success('User deleted.');
            fetchUsers();
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Something went wrong.';
            toast.error(msg);
        }
    };

    const startEdit = (u: UserItem) => {
        setEditingUser(u);
        setFormUsername(u.username);
        setFormRole(u.role);
        setFormPassword('');
        setFormConfirmPassword('');
        setShowForm(true);
        fetchRoleAssignments(u.id);
        void fetchAvailableNodes();
    };

    // --- Scoped Role Assignments ---
    const [roleAssignments, setRoleAssignments] = useState<RoleAssignmentItem[]>([]);
    const [scopeResourceType, setScopeResourceType] = useState<'stack' | 'node'>('stack');
    const [scopeNodeId, setScopeNodeId] = useState<string>('');
    const [scopeResourceId, setScopeResourceId] = useState('');
    const [scopeRole, setScopeRole] = useState<UserRole>('deployer');
    const [availableStacks, setAvailableStacks] = useState<string[]>([]);
    const [availableNodes, setAvailableNodes] = useState<{ id: number; name: string }[]>([]);
    const [loadingStacks, setLoadingStacks] = useState(false);
    const [addingScope, setAddingScope] = useState(false);

    const fetchRoleAssignments = async (userId: number) => {
        try {
            const res = await apiFetch(`/users/${userId}/roles`, { localOnly: true });
            if (res.ok) setRoleAssignments(await res.json());
            else setRoleAssignments([]);
        } catch { setRoleAssignments([]); }
    };

    const fetchAvailableNodes = async () => {
        try {
            const nodesRes = await apiFetch('/nodes', { localOnly: true });
            if (nodesRes.ok) {
                const data = await nodesRes.json();
                setAvailableNodes(Array.isArray(data) ? data.map((n: { id: number; name: string }) => ({ id: n.id, name: n.name })) : []);
            }
        } catch { /* ignore */ }
    };

    const fetchStacksForNode = async (nodeIdStr: string) => {
        if (!nodeIdStr) {
            setAvailableStacks([]);
            return;
        }
        const nodeId = parseInt(nodeIdStr, 10);
        if (!Number.isInteger(nodeId)) {
            setAvailableStacks([]);
            return;
        }
        setLoadingStacks(true);
        try {
            const stacksRes = await apiFetch('/stacks', { nodeId });
            if (stacksRes.ok) {
                const data = await stacksRes.json();
                setAvailableStacks(Array.isArray(data) ? data.filter((s: unknown): s is string => typeof s === 'string') : []);
            } else {
                setAvailableStacks([]);
                toast.error('Failed to load stacks for the selected node.');
            }
        } catch {
            setAvailableStacks([]);
            toast.error('Failed to load stacks for the selected node.');
        } finally {
            setLoadingStacks(false);
        }
    };

    const addRoleAssignment = async () => {
        if (!editingUser || !scopeResourceId) return;
        if (scopeResourceType === 'stack' && !scopeNodeId) return;
        setAddingScope(true);
        try {
            const body: Record<string, unknown> = {
                role: scopeRole,
                resource_type: scopeResourceType,
                resource_id: scopeResourceId,
            };
            if (scopeResourceType === 'stack') {
                body.node_id = parseInt(scopeNodeId, 10);
            }
            const res = await apiFetch(`/users/${editingUser.id}/roles`, {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json();
                toast.error(err?.error || err?.message || 'Failed to add scope.');
                return;
            }
            toast.success('Scope added.');
            setScopeResourceId('');
            fetchRoleAssignments(editingUser.id);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Something went wrong.';
            toast.error(msg);
        } finally { setAddingScope(false); }
    };

    const removeRoleAssignment = async (assignId: number) => {
        if (!editingUser) return;
        try {
            const res = await apiFetch(`/users/${editingUser.id}/roles/${assignId}`, { method: 'DELETE', localOnly: true });
            if (!res.ok) {
                const err = await res.json();
                toast.error(err?.error || err?.message || 'Failed to remove scope.');
                return;
            }
            toast.success('Scope removed.');
            fetchRoleAssignments(editingUser.id);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Something went wrong.';
            toast.error(msg);
        }
    };

    return (
        <CapabilityGate capability="users" featureName="User Management">
            <div className="flex flex-col gap-10">
                {!showForm && (
                    <div className="flex justify-end">
                        <SettingsPrimaryButton size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
                            <Plus className="w-4 h-4" strokeWidth={1.5} />Add user
                        </SettingsPrimaryButton>
                    </div>
                )}

                {/* Add/Edit Form */}
                {showForm && (
                    <div className="space-y-4 bg-glass border border-glass-border p-4 rounded-lg">
                        <h4 className="text-sm font-medium">{editingUser ? 'Edit User' : 'New User'}</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Username</Label>
                                <Input
                                    value={formUsername}
                                    onChange={(e) => setFormUsername(e.target.value)}
                                    placeholder="username"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Role</Label>
                                <Combobox
                                    options={[
                                        { value: 'admin', label: 'Admin' },
                                        { value: 'viewer', label: 'Viewer' },
                                        { value: 'deployer', label: 'Deployer' },
                                        { value: 'node-admin', label: 'Node Admin' },
                                        { value: 'auditor', label: 'Auditor' },
                                    ]}
                                    value={formRole}
                                    onValueChange={(v) => setFormRole(v as UserRole)}
                                    placeholder="Select role..."
                                />
                            </div>
                        </div>
                        {/* Hide password fields for SSO-provisioned users */}
                        {(!editingUser || editingUser.auth_provider === 'local') ? (
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>{editingUser ? 'New Password (optional)' : 'Password'}</Label>
                                    <Input
                                        type="password"
                                        value={formPassword}
                                        onChange={(e) => setFormPassword(e.target.value)}
                                        placeholder={editingUser ? 'Leave blank to keep' : 'min. 8 characters'}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Confirm Password</Label>
                                    <Input
                                        type="password"
                                        value={formConfirmPassword}
                                        onChange={(e) => setFormConfirmPassword(e.target.value)}
                                        placeholder="Confirm password"
                                    />
                                </div>
                            </div>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                Password is managed by the identity provider ({editingUser.auth_provider}).
                            </p>
                        )}
                        <div className="flex gap-2 justify-end">
                            <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
                            <SettingsPrimaryButton size="sm" onClick={handleSave} disabled={saving}>
                                {saving ? <><RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.5} />Saving</> : (editingUser ? 'Update user' : 'Create user')}
                            </SettingsPrimaryButton>
                        </div>

                        {/* Scoped Permissions (editing only) */}
                        {editingUser && (
                            <div className="border border-glass-border rounded-lg p-4 space-y-3 mt-4">
                                <h4 className="text-sm font-medium">Scoped Permissions</h4>
                                <p className="text-xs text-muted-foreground">
                                    Grant additional permissions on specific stacks or nodes. These supplement the user's global role.
                                </p>

                                {roleAssignments.length > 0 && (
                                    <div className="space-y-1">
                                        {roleAssignments.map((a) => {
                                            const nodeLabel = a.resource_type === 'stack' && a.node_id != null
                                                ? (availableNodes.find((n) => n.id === a.node_id)?.name ?? `node ${a.node_id}`)
                                                : null;
                                            return (
                                            <div key={a.id} className="flex items-center justify-between text-sm bg-muted/50 rounded px-3 py-1.5">
                                                <span>
                                                    <Badge variant="outline" className="text-xs mr-2 capitalize">{a.role}</Badge>
                                                    on <span className="font-medium capitalize">{a.resource_type}</span>: <span className="font-mono text-xs">{a.resource_id}</span>
                                                    {nodeLabel != null && (
                                                        <span className="text-muted-foreground"> @ {nodeLabel}</span>
                                                    )}
                                                </span>
                                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeRoleAssignment(a.id)}>
                                                    <Trash2 className="w-3 h-3 text-destructive" strokeWidth={1.5} />
                                                </Button>
                                            </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="flex items-end gap-2 flex-wrap">
                                    <div className="space-y-1">
                                        <Label className="text-xs">Role</Label>
                                        <Combobox
                                            options={[
                                                { value: 'deployer', label: 'Deployer' },
                                                { value: 'node-admin', label: 'Node Admin' },
                                                { value: 'admin', label: 'Admin' },
                                            ]}
                                            value={scopeRole}
                                            onValueChange={(v) => setScopeRole(v as UserRole)}
                                            placeholder="Role..."
                                            className="h-8 text-xs w-[120px]"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Resource Type</Label>
                                        <Combobox
                                            options={[
                                                { value: 'stack', label: 'Stack' },
                                                { value: 'node', label: 'Node' },
                                            ]}
                                            value={scopeResourceType}
                                            onValueChange={(v) => {
                                                setScopeResourceType(v as 'stack' | 'node');
                                                setScopeResourceId('');
                                                setScopeNodeId('');
                                                setAvailableStacks([]);
                                                void fetchAvailableNodes();
                                            }}
                                            placeholder="Type..."
                                            className="h-8 text-xs w-[100px]"
                                        />
                                    </div>
                                    {scopeResourceType === 'stack' && (
                                        <div className="space-y-1">
                                            <Label className="text-xs">Node</Label>
                                            <Combobox
                                                options={availableNodes.map((n) => ({ value: String(n.id), label: n.name }))}
                                                value={scopeNodeId}
                                                onValueChange={(v) => {
                                                    setScopeNodeId(v);
                                                    setScopeResourceId('');
                                                    void fetchStacksForNode(v);
                                                }}
                                                placeholder="Select node..."
                                                className="h-8 text-xs w-[140px]"
                                            />
                                        </div>
                                    )}
                                    <div className="space-y-1 flex-1 min-w-[140px]">
                                        <Label className="text-xs">{scopeResourceType === 'stack' ? 'Stack' : 'Node'}</Label>
                                        <Combobox
                                            options={scopeResourceType === 'stack'
                                                ? availableStacks.map((s) => ({ value: s, label: s }))
                                                : availableNodes.map((n) => ({ value: String(n.id), label: n.name }))
                                            }
                                            value={scopeResourceId}
                                            onValueChange={setScopeResourceId}
                                            placeholder={
                                                scopeResourceType === 'stack'
                                                    ? (loadingStacks ? 'Loading stacks...' : (!scopeNodeId ? 'Select a node first...' : 'Select stack...'))
                                                    : 'Select...'
                                            }
                                            className="h-8 text-xs"
                                            disabled={scopeResourceType === 'stack' && (!scopeNodeId || loadingStacks)}
                                        />
                                    </div>
                                    <Button
                                        size="sm"
                                        className="h-8"
                                        onClick={addRoleAssignment}
                                        disabled={
                                            addingScope
                                            || !scopeResourceId
                                            || (scopeResourceType === 'stack' && !scopeNodeId)
                                        }
                                    >
                                        <Plus className="w-3 h-3 mr-1" strokeWidth={1.5} />
                                        Add
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Users Table */}
                {loading ? (
                    <div className="space-y-3">
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ) : users.length === 0 ? (
                    <SettingsCallout
                        title="No users yet"
                        subtitle="Add an operator to give someone else access to this control plane."
                    />
                ) : (
                    <SettingsSection title="Users" kicker={`${users.length} total`}>
                        <div className="mt-3 border border-glass-border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-muted/30 border-b border-glass-border">
                                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Username</th>
                                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Role</th>
                                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Created</th>
                                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map((u) => {
                                        const isSelf = u.username === currentUser?.username;
                                        return (
                                            <tr key={u.id} className="border-b border-glass-border last:border-0 hover:bg-muted/10">
                                                <td className="px-4 py-2.5 font-medium">
                                                    {u.username}
                                                    {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                                                </td>
                                                <td className="px-4 py-2.5">
                                                    <Badge variant={u.role === 'admin' ? 'default' : u.role === 'viewer' ? 'secondary' : 'outline'} className="text-xs capitalize">
                                                        {u.role}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-2.5 text-muted-foreground">
                                                    {new Date(u.created_at).toLocaleDateString()}
                                                </td>
                                                <td className="px-4 py-2.5 text-right">
                                                    <div className="flex gap-1 justify-end">
                                                        <Button variant="ghost" size="sm" onClick={() => startEdit(u)}>
                                                            <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                        </Button>
                                                        {u.mfaEnabled && (
                                                            <TooltipProvider>
                                                                <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="sm"
                                                                            onClick={() => setResetMfaTarget(u)}
                                                                        >
                                                                            <ShieldOff className="w-3.5 h-3.5 text-warning" strokeWidth={1.5} />
                                                                        </Button>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent>Reset 2FA</TooltipContent>
                                                                </Tooltip>
                                                            </TooltipProvider>
                                                        )}
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            disabled={isSelf}
                                                            onClick={() => setDeleteTarget(u)}
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5 text-destructive" strokeWidth={1.5} />
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </SettingsSection>
                )}

                <SessionPolicySection />

                <ConfirmModal
                    open={resetMfaTarget !== null}
                    onOpenChange={(open) => { if (!open) setResetMfaTarget(null); }}
                    kicker="USERS · RESET 2FA"
                    title={`Reset 2FA for ${resetMfaTarget?.username ?? ''}`}
                    confirmLabel="Reset 2FA"
                    onConfirm={() => {
                        if (resetMfaTarget) {
                            const user = resetMfaTarget;
                            setResetMfaTarget(null);
                            handleResetMfa(user.id, user.username);
                        }
                    }}
                >
                    <p className="text-sm text-stat-subtitle">
                        Removes the user's authenticator enrolment and backup codes. They will sign in with just their password on their next login and can re-enrol from their account settings. Use this when a user has lost access to their authenticator.
                    </p>
                </ConfirmModal>

                <ConfirmModal
                    open={deleteTarget !== null}
                    onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
                    variant="destructive"
                    kicker="USERS · DELETE · IRREVERSIBLE"
                    title={`Delete user "${deleteTarget?.username ?? ''}"`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                        if (deleteTarget) {
                            const id = deleteTarget.id;
                            setDeleteTarget(null);
                            handleDelete(id);
                        }
                    }}
                >
                    <p className="text-sm text-stat-subtitle">
                        Removes the user immediately. They lose access right away.
                    </p>
                </ConfirmModal>
            </div>
        </CapabilityGate>
    );
}
