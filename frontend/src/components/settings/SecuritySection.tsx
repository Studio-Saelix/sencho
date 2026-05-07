import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { ShieldCheck, Plus, Trash2, Pencil, Download, RefreshCw, Loader2, Info } from 'lucide-react';
import { SettingsCallout } from './SettingsCallout';
import { SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import type { FleetRole, ScanPolicy, VulnSeverity } from '@/types/security';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { SuppressionsPanel } from './SuppressionsPanel';

const SEVERITY_OPTIONS: Array<{ value: VulnSeverity; label: string }> = [
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
];

interface PolicyFormState {
  name: string;
  stack_pattern: string;
  max_severity: VulnSeverity;
  block_on_deploy: boolean;
  enabled: boolean;
}

const EMPTY_FORM: PolicyFormState = {
  name: '',
  stack_pattern: '',
  max_severity: 'CRITICAL',
  block_on_deploy: false,
  enabled: true,
};

const TRIVY_SOURCE_BADGES: Record<'managed' | 'host' | 'none', { label: string; variant: 'outline' | 'secondary' }> = {
  managed: { label: 'Installed (managed)', variant: 'outline' },
  host: { label: 'Installed (host)', variant: 'outline' },
  none: { label: 'Not installed', variant: 'secondary' },
};

const TRIVY_SOURCE_DESCRIPTIONS: Record<'managed' | 'host' | 'none', string | null> = {
  managed: null,
  host: 'Managed externally via the host binary. Install and updates are handled outside Sencho.',
  none: "Install Trivy into Sencho's data volume to enable image vulnerability scanning. No host mounts required.",
};

const TRIVY_OP_LABELS: Record<'install' | 'update' | 'uninstall', { loading: string; success: string }> = {
  install: { loading: 'Installing Trivy...', success: 'Trivy installed' },
  update: { loading: 'Updating Trivy...', success: 'Trivy updated' },
  uninstall: { loading: 'Removing Trivy...', success: 'Trivy removed' },
};

export function SecuritySection({ isPaid }: { isPaid: boolean }) {
  const [policies, setPolicies] = useState<ScanPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PolicyFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { license } = useLicense();
  const isAdmiral = isPaid && license?.variant === 'admiral';
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  const { status: trivy, updateCheck, refresh: refreshTrivy, refreshUpdateCheck } = useTrivyStatus();
  const [trivyBusy, setTrivyBusy] = useState<null | 'install' | 'update' | 'uninstall' | 'auto-update'>(null);
  const [uninstallConfirm, setUninstallConfirm] = useState(false);
  const [fleetRole, setFleetRole] = useState<FleetRole>('control');
  const isReplica = fleetRole === 'replica';

  const runTrivyOp = async (
    op: 'install' | 'update' | 'uninstall',
    path: string,
    method: 'POST' | 'DELETE',
  ) => {
    const { loading, success } = TRIVY_OP_LABELS[op];
    setTrivyBusy(op);
    const toastId = toast.loading(loading);
    try {
      const res = await apiFetch(path, { method });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `Trivy ${op} failed`);
      }
      toast.success(success);
      await Promise.all([refreshTrivy(), refreshUpdateCheck()]);
    } catch (err) {
      toast.error((err as Error)?.message || `Trivy ${op} failed`);
    } finally {
      toast.dismiss(toastId);
      setTrivyBusy(null);
    }
  };

  const handleInstallTrivy = () => runTrivyOp('install', '/security/trivy-install', 'POST');
  const handleUpdateTrivy = () => runTrivyOp('update', '/security/trivy-update', 'POST');
  const handleUninstallTrivy = async () => {
    setUninstallConfirm(false);
    await runTrivyOp('uninstall', '/security/trivy-install', 'DELETE');
  };

  const handleAutoUpdateToggle = async (enabled: boolean) => {
    setTrivyBusy('auto-update');
    try {
      const res = await apiFetch('/security/trivy-auto-update', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to update setting');
      }
      await refreshTrivy();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to update setting');
    } finally {
      setTrivyBusy(null);
    }
  };

  const fetchPolicies = async () => {
    try {
      const res = await apiFetch('/security/policies', { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setPolicies(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to load scan policies:', err);
      toast.error('Failed to load scan policies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isPaid) { setLoading(false); return; }
    if (isRemote) { setPolicies([]); setLoading(false); return; }
    fetchPolicies();
  }, [isPaid, isRemote]);

  useEffect(() => {
    void refreshTrivy();
  }, [activeNode?.id, refreshTrivy]);

  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/fleet/role', { localOnly: true });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && (data?.role === 'control' || data?.role === 'replica')) {
          setFleetRole(data.role);
        }
      } catch {
        /* fallback: treat as control if the check fails */
      }
    })();
    return () => { cancelled = true; };
  }, [isRemote]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (policy: ScanPolicy) => {
    setEditingId(policy.id);
    setForm({
      name: policy.name,
      stack_pattern: policy.stack_pattern ?? '',
      max_severity: policy.max_severity,
      block_on_deploy: policy.block_on_deploy === 1,
      enabled: policy.enabled === 1,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Policy name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        stack_pattern: form.stack_pattern.trim() || null,
        max_severity: form.max_severity,
        block_on_deploy: form.block_on_deploy ? 1 : 0,
        enabled: form.enabled ? 1 : 0,
      };
      const url = editingId ? `/security/policies/${editingId}` : '/security/policies';
      const method = editingId ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        localOnly: true,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to save policy');
      }
      toast.success(editingId ? 'Policy updated' : 'Policy created');
      setDialogOpen(false);
      fetchPolicies();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleteId == null) return;
    try {
      const res = await apiFetch(`/security/policies/${deleteId}`, {
        method: 'DELETE',
        localOnly: true,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to delete policy');
      }
      toast.success('Policy deleted');
      fetchPolicies();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to delete policy');
    } finally {
      setDeleteId(null);
    }
  };

  useMastheadStats(
    loading
      ? null
      : [
          ...(isPaid ? [{ label: 'POLICIES', value: `${policies.length}` }] : []),
          {
            label: 'TRIVY',
            value: trivy.source === 'none' ? 'missing' : trivy.source,
            tone: trivy.source === 'none' ? 'warn' : 'value' as const,
          },
        ],
  );

  return (
    <div className="space-y-6">
      {isPaid && !isRemote && !isReplica && (
        <div className="flex justify-end">
          <SettingsPrimaryButton size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4" />
            Add policy
          </SettingsPrimaryButton>
        </div>
      )}

      {!isRemote && isReplica && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-lg border border-card-border bg-muted/30 px-4 py-3"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-sm">
            <div className="font-medium">Managed by control node</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Security policies replicate from the control Sencho instance. View them here for audit; edit them on the control.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
            <span className="font-medium text-sm">Vulnerability Scanner</span>
            <Badge variant={TRIVY_SOURCE_BADGES[trivy.source].variant} className="text-[10px] shrink-0">
              {TRIVY_SOURCE_BADGES[trivy.source].label}
            </Badge>
            {updateCheck?.updateAvailable && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                Update available to v{updateCheck.latest}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {trivy.source === 'none' && (
              <SettingsPrimaryButton size="sm" onClick={handleInstallTrivy} disabled={trivyBusy !== null}>
                {trivyBusy === 'install' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Download className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
                )}
                Install Trivy
              </SettingsPrimaryButton>
            )}
            {trivy.source === 'managed' && updateCheck?.updateAvailable && (
              <Button size="sm" variant="outline" onClick={handleUpdateTrivy} disabled={trivyBusy !== null}>
                {trivyBusy === 'update' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
                )}
                Update
              </Button>
            )}
            {trivy.source === 'managed' && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                onClick={() => setUninstallConfirm(true)}
                disabled={trivyBusy !== null}
              >
                Uninstall
              </Button>
            )}
          </div>
        </div>

        {trivy.source === 'managed' && trivy.version && (
          <div className="text-xs text-stat-subtitle font-mono">Version: v{trivy.version}</div>
        )}
        {TRIVY_SOURCE_DESCRIPTIONS[trivy.source] && (
          <div className="text-xs text-stat-subtitle">{TRIVY_SOURCE_DESCRIPTIONS[trivy.source]}</div>
        )}

        {trivy.source === 'managed' && isAdmiral && (
          <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
            <div>
              <Label className="text-sm">Auto-update Trivy</Label>
              <p className="text-xs text-muted-foreground">
                Check daily and install newer Trivy releases automatically.
              </p>
            </div>
            <TogglePill
              checked={trivy.autoUpdate}
              onChange={handleAutoUpdateToggle}
              disabled={trivyBusy !== null}
            />
          </div>
        )}
      </div>

      {isRemote && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-lg border border-card-border bg-muted/30 px-4 py-3"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-sm">
            <div className="font-medium">Scanner is per-node</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Trivy is installed independently on each Sencho instance. Scan policies and CVE suppressions are managed on the control node.
            </p>
          </div>
        </div>
      )}

      {!isRemote && loading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      )}

      {isPaid && !isRemote && !loading && policies.length === 0 && (
        <SettingsCallout
          icon={<ShieldCheck className="h-4 w-4" />}
          title="No scan policies configured"
          subtitle="Add one to enforce severity thresholds across your fleet."
        />
      )}

      {isPaid && !isRemote && !loading &&
        policies.map((policy) => (
          <div key={policy.id} className="border border-glass-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="font-medium text-sm truncate">{policy.name}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  max: {policy.max_severity}
                </Badge>
                {policy.block_on_deploy === 1 && (
                  <Badge variant="destructive" className="text-[10px] shrink-0">
                    block
                  </Badge>
                )}
                {policy.enabled === 0 && (
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    disabled
                  </Badge>
                )}
              </div>
              {!isReplica && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(policy)}
                  >
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                    onClick={() => setDeleteId(policy.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </Button>
                </div>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Scope: {policy.stack_pattern ? (
                <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">{policy.stack_pattern}</code>
              ) : (
                <span className="italic">all stacks</span>
              )}
            </div>
          </div>
        ))}

      {!isRemote && <SuppressionsPanel isReplica={isReplica} />}

      {isPaid && (
        <>
          <Modal open={dialogOpen} onOpenChange={setDialogOpen} size="md">
            <ModalHeader
              kicker={editingId ? 'SECURITY · EDIT POLICY' : 'SECURITY · NEW POLICY'}
              title={editingId ? 'Edit policy' : 'New policy'}
              description="Configure the severity threshold and scope for this scan policy."
            />
            <ModalBody>
              <div className="space-y-2">
                <Label htmlFor="policy-name">Name</Label>
                <Input
                  id="policy-name"
                  placeholder="Production block on critical"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policy-pattern">Stack pattern (optional)</Label>
                <Input
                  id="policy-pattern"
                  placeholder="e.g. prod-* or leave blank for all"
                  value={form.stack_pattern}
                  onChange={(e) => setForm({ ...form, stack_pattern: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Glob-style pattern matched against stack names. Leave blank to apply to all stacks.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max severity</Label>
                <Combobox
                  options={SEVERITY_OPTIONS}
                  value={form.max_severity}
                  onValueChange={(v) => setForm({ ...form, max_severity: v as VulnSeverity })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
                <div>
                  <Label className="text-sm">Block on deploy</Label>
                  <p className="text-xs text-muted-foreground">
                    Emit a critical alert when this policy is violated after a deploy.
                  </p>
                </div>
                <TogglePill
                  checked={form.block_on_deploy}
                  onChange={(c) => setForm({ ...form, block_on_deploy: c })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
                <div>
                  <Label className="text-sm">Enabled</Label>
                  <p className="text-xs text-muted-foreground">Disabled policies are skipped during evaluation.</p>
                </div>
                <TogglePill
                  checked={form.enabled}
                  onChange={(c) => setForm({ ...form, enabled: c })}
                />
              </div>
            </ModalBody>
            <ModalFooter
              secondary={
                <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
              }
              primary={
                <SettingsPrimaryButton size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </SettingsPrimaryButton>
              }
            />
          </Modal>

          <ConfirmModal
            open={deleteId != null}
            onOpenChange={(open) => !open && setDeleteId(null)}
            variant="destructive"
            kicker="SECURITY · DELETE · IRREVERSIBLE"
            title="Delete scan policy"
            confirmLabel="Delete"
            onConfirm={handleDelete}
          >
            <p className="text-sm text-stat-subtitle">
              Removes the policy immediately. Existing scans are not affected.
            </p>
          </ConfirmModal>
        </>
      )}

      <ConfirmModal
        open={uninstallConfirm}
        onOpenChange={setUninstallConfirm}
        variant="destructive"
        kicker="TRIVY · REMOVE · IRREVERSIBLE"
        title="Remove Trivy"
        confirmLabel="Remove"
        onConfirm={handleUninstallTrivy}
      >
        <p className="text-sm text-stat-subtitle">
          Removes the managed Trivy binary. Vulnerability scanning stops working until Trivy is reinstalled or a host binary is provided.
        </p>
      </ConfirmModal>
    </div>
  );
}
