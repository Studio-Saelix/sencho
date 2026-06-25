import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { ShieldCheck, Download, RefreshCw, Loader2 } from 'lucide-react';
import { SettingsPrimaryButton } from '@/components/settings/SettingsActions';
import { useAuth } from '@/context/AuthContext';
import type { TrivyStatus, TrivyUpdateCheck, TrivySource } from '@/types/security';

const TRIVY_SOURCE_BADGES: Record<TrivySource, { label: string; variant: 'outline' | 'secondary' }> = {
  managed: { label: 'Installed (managed)', variant: 'outline' },
  host: { label: 'Installed (host)', variant: 'outline' },
  none: { label: 'Not installed', variant: 'secondary' },
};

const TRIVY_SOURCE_DESCRIPTIONS: Record<TrivySource, string | null> = {
  managed: null,
  host: 'Managed externally via the host binary. Install and updates are handled outside Sencho.',
  none: "Install Trivy into Sencho's data volume to enable image vulnerability scanning. No host mounts required.",
};

const TRIVY_OP_LABELS: Record<'install' | 'update' | 'uninstall', { loading: string; success: string }> = {
  install: { loading: 'Installing Trivy...', success: 'Trivy installed' },
  update: { loading: 'Updating Trivy...', success: 'Trivy updated' },
  uninstall: { loading: 'Removing Trivy...', success: 'Trivy removed' },
};

interface TrivyManagerProps {
  status: TrivyStatus;
  updateCheck: TrivyUpdateCheck | null;
  refresh: () => Promise<void>;
  refreshUpdateCheck: () => Promise<void>;
}

/**
 * Scanner install/update/uninstall/auto-update controls for managed Trivy.
 * Controlled: the parent owns the single `useTrivyStatus` instance and passes
 * the status plus refresh callbacks, so a host that renders this alongside
 * other Trivy-derived UI (the Settings security section) keeps one source of
 * truth. Mounted by both the Settings security section and the Security page
 * Scanner setup tab.
 */
export function TrivyManager({ status, updateCheck, refresh, refreshUpdateCheck }: TrivyManagerProps) {
  const { isAdmin } = useAuth();
  const [trivyBusy, setTrivyBusy] = useState<null | 'install' | 'update' | 'uninstall' | 'auto-update' | 'advisory' | 'cve-intel'>(null);
  const [uninstallConfirm, setUninstallConfirm] = useState(false);

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
      await Promise.all([refresh(), refreshUpdateCheck()]);
    } catch (err) {
      toast.error((err as Error)?.message || `Trivy ${op} failed`);
    } finally {
      toast.dismiss(toastId);
      setTrivyBusy(null);
    }
  };

  const handleInstall = () => runTrivyOp('install', '/security/trivy-install', 'POST');
  const handleUpdate = () => runTrivyOp('update', '/security/trivy-update', 'POST');
  const handleUninstall = async () => {
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
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to update setting');
    } finally {
      setTrivyBusy(null);
    }
  };

  const handleAdvisoryToggle = async (enabled: boolean) => {
    setTrivyBusy('advisory');
    try {
      const res = await apiFetch('/security/pre-deploy-scan-advisory', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to update setting');
      }
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to update setting');
    } finally {
      setTrivyBusy(null);
    }
  };

  const handleCveIntelToggle = async (enabled: boolean) => {
    setTrivyBusy('cve-intel');
    try {
      const res = await apiFetch('/security/cve-intel-enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to update setting');
      }
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to update setting');
    } finally {
      setTrivyBusy(null);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
            <span className="font-medium text-sm">Vulnerability Scanner</span>
            <Badge variant={TRIVY_SOURCE_BADGES[status.source].variant} className="text-[10px] shrink-0">
              {TRIVY_SOURCE_BADGES[status.source].label}
            </Badge>
            {updateCheck?.updateAvailable && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                Update available to v{updateCheck.latest}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isAdmin && status.source === 'none' && (
              <SettingsPrimaryButton size="sm" onClick={handleInstall} disabled={trivyBusy !== null}>
                {trivyBusy === 'install' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Download className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
                )}
                Install Trivy
              </SettingsPrimaryButton>
            )}
            {isAdmin && status.source === 'managed' && updateCheck?.updateAvailable && (
              <Button size="sm" variant="outline" onClick={handleUpdate} disabled={trivyBusy !== null}>
                {trivyBusy === 'update' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
                )}
                Update
              </Button>
            )}
            {isAdmin && status.source === 'managed' && (
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

        {status.source === 'managed' && status.version && (
          <div className="text-xs text-stat-subtitle font-mono">Version: v{status.version}</div>
        )}
        {TRIVY_SOURCE_DESCRIPTIONS[status.source] && (
          <div className="text-xs text-stat-subtitle">{TRIVY_SOURCE_DESCRIPTIONS[status.source]}</div>
        )}

        {status.source === 'managed' && isAdmin && (
          <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
            <div>
              <Label className="text-sm">Auto-update Trivy</Label>
              <p className="text-xs text-muted-foreground">
                Check daily and install newer Trivy releases automatically.
              </p>
            </div>
            <TogglePill
              checked={status.autoUpdate}
              onChange={handleAutoUpdateToggle}
              disabled={trivyBusy !== null}
            />
          </div>
        )}

        {(status.available || status.preDeployScanAdvisory) && isAdmin && (
          <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
            <div>
              <Label className="text-sm">Pre-deploy scan advisory</Label>
              <p className="text-xs text-muted-foreground">
                Before a manual deploy, show each image's latest scan results so you can review them first. Advisory only; it never blocks the deploy.
              </p>
            </div>
            <TogglePill
              checked={status.preDeployScanAdvisory}
              onChange={handleAdvisoryToggle}
              disabled={trivyBusy !== null}
            />
          </div>
        )}

        {isAdmin && (
          <div className="flex items-center justify-between rounded-lg border border-glass-border px-3 py-2.5">
            <div>
              <Label className="text-sm">Exploit intelligence (KEV + EPSS)</Label>
              <p className="text-xs text-muted-foreground">
                Fetch CISA Known Exploited Vulnerabilities and EPSS scores daily to prioritize findings. Reaches cisa.gov and api.first.org; turn off for air-gapped hosts.
              </p>
            </div>
            <TogglePill
              checked={status.cveIntelEnabled}
              onChange={handleCveIntelToggle}
              disabled={trivyBusy !== null}
            />
          </div>
        )}
      </div>

      <ConfirmModal
        open={uninstallConfirm}
        onOpenChange={setUninstallConfirm}
        variant="destructive"
        kicker="TRIVY · REMOVE · IRREVERSIBLE"
        title="Remove Trivy"
        confirmLabel="Remove"
        onConfirm={handleUninstall}
      >
        <p className="text-sm text-stat-subtitle">
          Removes the managed Trivy binary. Vulnerability scanning stops working until Trivy is reinstalled or a host binary is provided.
        </p>
      </ConfirmModal>
    </>
  );
}
