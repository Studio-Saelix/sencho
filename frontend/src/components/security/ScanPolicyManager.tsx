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
import { ShieldCheck, Plus, Trash2, Pencil, Info } from 'lucide-react';
import { SettingsCallout } from '@/components/settings/SettingsCallout';
import { SettingsPrimaryButton } from '@/components/settings/SettingsActions';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import type { FleetRole, ScanPolicy, VulnSeverity } from '@/types/security';

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

/**
 * Deploy-enforcement scan policies (block-on-deploy severity thresholds), the
 * honor-suppressions toggle, and the replica "managed by control" state. This
 * is the paid governance surface for the Security page Policies tab; it returns
 * null for Community (no enforcement management) so the catalog is all a
 * Community operator sees. Policies are control-governed: fetched localOnly and
 * shown only on the local node, mirroring how the rest of the fleet-governance
 * UI behaves.
 */
export function ScanPolicyManager() {
  const { isPaid } = useLicense();
  const { isAdmin } = useAuth();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  const { status: trivy, refresh: refreshTrivy } = useTrivyStatus();

  const [policies, setPolicies] = useState<ScanPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PolicyFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [honorBusy, setHonorBusy] = useState(false);
  const [fleetRole, setFleetRole] = useState<FleetRole>('control');
  const [fleetRoleProbeFailed, setFleetRoleProbeFailed] = useState(false);
  const [demoteConfirm, setDemoteConfirm] = useState(false);
  const [demoteBusy, setDemoteBusy] = useState(false);
  const isReplica = fleetRole === 'replica';

  const fetchPolicies = async () => {
    setLoadError(false);
    try {
      const res = await apiFetch('/security/policies', { localOnly: true });
      if (!res.ok) {
        // A non-OK response must not read as "no policies configured", which
        // would falsely imply nothing is enforcing.
        setLoadError(true);
        return;
      }
      const data = await res.json();
      setPolicies(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load scan policies:', err);
      toast.error('Failed to load scan policies');
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isPaid || isRemote) { setLoading(false); return; }
    fetchPolicies();
  }, [isPaid, isRemote]);

  useEffect(() => {
    if (!isPaid || isRemote) return;
    void refreshTrivy();
  }, [isPaid, isRemote, activeNode?.id, refreshTrivy]);

  useEffect(() => {
    if (!isPaid || isRemote) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/fleet/role', { localOnly: true });
        if (!res.ok) {
          if (!cancelled) setFleetRoleProbeFailed(true);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data?.role === 'control' || data?.role === 'replica') {
          setFleetRole(data.role);
          setFleetRoleProbeFailed(false);
        } else {
          setFleetRoleProbeFailed(true);
        }
      } catch {
        if (!cancelled) setFleetRoleProbeFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isPaid, isRemote]);

  const handleHonorSuppressionsToggle = async (enabled: boolean) => {
    setHonorBusy(true);
    try {
      const res = await apiFetch('/security/deploy-block-honor-suppressions', {
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
      setHonorBusy(false);
    }
  };

  const handleDemote = async () => {
    setDemoteBusy(true);
    try {
      const res = await apiFetch('/fleet/role/demote', {
        method: 'POST',
        localOnly: true,
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Demote failed');
      }
      toast.success('Replica demoted to control');
      setFleetRole('control');
      setDemoteConfirm(false);
      fetchPolicies();
    } catch (err) {
      toast.error((err as Error)?.message || 'Demote failed');
    } finally {
      setDemoteBusy(false);
    }
  };

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

  // Enforcement management is a paid governance surface; Community sees only the
  // policy-pack catalog above it.
  if (!isPaid) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">Deploy enforcement policies</h3>
        {isAdmin && !isRemote && !isReplica && (
          <SettingsPrimaryButton size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4" />
            Add policy
          </SettingsPrimaryButton>
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
            <div className="font-medium">Managed on the local instance</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Scan policies are managed on the local Sencho instance. Switch to the local node to manage them.
            </p>
          </div>
        </div>
      )}

      {!isRemote && isReplica && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start justify-between gap-3 rounded-lg border border-card-border bg-muted/30 px-4 py-3"
        >
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
            <div className="text-sm">
              <div className="font-medium">Managed by control node</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Security policies replicate from the control Sencho instance. View them here for audit; edit them on the control.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setDemoteConfirm(true)}
            disabled={demoteBusy}
          >
            Demote to control
          </Button>
        </div>
      )}

      {!isRemote && fleetRoleProbeFailed && !isReplica && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-lg border border-card-border bg-muted/30 px-4 py-3"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-sm">
            <div className="font-medium">Fleet role could not be determined</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Treating this instance as a control. Refresh the page to retry.
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

      {!isRemote && !loading && loadError && (
        <SettingsCallout
          icon={<ShieldCheck className="h-4 w-4" />}
          title="Couldn't load scan policies"
          subtitle="Scan policies failed to load. Try again shortly."
        />
      )}

      {!isRemote && !loading && !loadError && policies.length === 0 && (
        <SettingsCallout
          icon={<ShieldCheck className="h-4 w-4" />}
          title="No scan policies configured"
          subtitle="Add one to enforce severity thresholds across your fleet."
        />
      )}

      {!isRemote && !loading &&
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
              {isAdmin && !isReplica && (
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

      {isAdmin && !isRemote && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-4 py-3">
          <div className="min-w-0">
            <Label className="text-sm">Honor suppressions in deploy blocks</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              When on, a suppressed CVE no longer counts toward a block-on-deploy policy, so an accepted finding will not stop a deploy on this instance. Off by default: policies block on the raw scan result.
            </p>
          </div>
          <TogglePill
            checked={trivy.honorSuppressionsOnDeploy}
            onChange={handleHonorSuppressionsToggle}
            disabled={honorBusy}
          />
        </div>
      )}

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
                Reject a deploy before containers start when any image meets or exceeds the threshold. With this off, the policy only evaluates and raises an alert.
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

      <ConfirmModal
        open={demoteConfirm}
        onOpenChange={setDemoteConfirm}
        variant="destructive"
        kicker="FLEET · DEMOTE · IRREVERSIBLE"
        title="Demote replica to control"
        confirmLabel={demoteBusy ? 'Demoting...' : 'Demote'}
        onConfirm={handleDemote}
      >
        <p className="text-sm text-stat-subtitle">
          Removes every replicated scan policy and CVE suppression mirrored from the control. Local edits to security policies on this instance become available again.
        </p>
      </ConfirmModal>
    </div>
  );
}
