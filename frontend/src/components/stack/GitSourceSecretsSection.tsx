import { useCallback, useEffect, useState } from 'react';
import { Loader2, Copy, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

type PublicSopsIdentity = {
  id: string;
  recipient: string;
  label: string | null;
  createdAt: number;
  rotatedAt: number | null;
};

type SopsIdentityImpact = {
  generationId: string;
  commitSha: string;
  status: string;
  requiredRecipients: string[];
};

type SopsReadiness = {
  identities: PublicSopsIdentity[];
  requiredRecipients: string[];
  ready: boolean;
  failureClass?: string;
  policy: 'allow_plaintext' | 'require_encrypted';
};

type SopsSecretsResponse = {
  encrypted_source_policy: 'allow_plaintext' | 'require_encrypted';
  identities: PublicSopsIdentity[];
  readiness: SopsReadiness;
};

interface GitSourceSecretsSectionProps {
  stackName: string;
  canEdit: boolean;
  linked: boolean;
  disabled?: boolean;
}

function impactSummary(impact: SopsIdentityImpact[]): string {
  if (impact.length === 0) return 'No generations on this node currently require this recipient.';
  const lines = impact.slice(0, 5).map(
    (row) => `${row.commitSha.slice(0, 7)} (${row.status})`,
  );
  const suffix = impact.length > 5 ? ` and ${impact.length - 5} more` : '';
  return `Affected generations: ${lines.join(', ')}${suffix}. Rollback or redeploy may fail until files are re-encrypted with a key you still hold.`;
}

export function GitSourceSecretsSection({
  stackName,
  canEdit,
  linked,
  disabled = false,
}: GitSourceSecretsSectionProps) {
  const [loading, setLoading] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [importValue, setImportValue] = useState('');
  const [data, setData] = useState<SopsSecretsResponse | null>(null);
  const [rotateTarget, setRotateTarget] = useState<PublicSopsIdentity | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicSopsIdentity | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<SopsIdentityImpact[]>([]);
  const [mutating, setMutating] = useState(false);

  const load = useCallback(async () => {
    if (!linked) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not load repository secrets');
        return;
      }
      const body = (await res.json()) as SopsSecretsResponse;
      setData(body);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load repository secrets');
    } finally {
      setLoading(false);
    }
  }, [linked, stackName]);

  useEffect(() => {
    void load();
  }, [load]);

  const generateIdentity = async () => {
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not generate identity');
        return;
      }
      toast.success('Age identity generated');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate identity');
    }
  };

  const importIdentity = async () => {
    const trimmed = importValue.trim();
    if (!trimmed) return;
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities/import`, {
        method: 'POST',
        body: JSON.stringify({ identity: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not import identity');
        return;
      }
      setImportValue('');
      toast.success('Age identity imported');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not import identity');
    }
  };

  const savePolicy = async (policy: 'allow_plaintext' | 'require_encrypted') => {
    setSavingPolicy(true);
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/git-source/encrypted-source-policy`, {
        method: 'PUT',
        body: JSON.stringify({ encrypted_source_policy: policy }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not update encrypted source policy');
        return;
      }
      toast.success('Encrypted source policy updated.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update encrypted source policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const copyRecipient = async (recipient: string) => {
    try {
      await navigator.clipboard.writeText(recipient);
      toast.success('Recipient copied');
    } catch {
      toast.error('Could not copy recipient');
    }
  };

  const confirmRotate = async () => {
    if (!rotateTarget) return;
    setMutating(true);
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities/${encodeURIComponent(rotateTarget.id)}/rotate`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not rotate identity');
        return;
      }
      toast.success('Identity rotated. Add the new recipient to SOPS files before deleting the old key.');
      setRotateTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rotate identity');
    } finally {
      setMutating(false);
    }
  };

  const requestDelete = async (identity: PublicSopsIdentity) => {
    setMutating(true);
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities/${encodeURIComponent(identity.id)}`,
        { method: 'DELETE', body: JSON.stringify({}) },
      );
      if (res.status === 409) {
        const body = (await res.json()) as { impact?: SopsIdentityImpact[] };
        setDeleteImpact(body.impact ?? []);
        setDeleteTarget(identity);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not delete identity');
        return;
      }
      toast.success('Identity deleted');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete identity');
    } finally {
      setMutating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setMutating(true);
    try {
      const res = await apiFetch(
        `/stacks/${encodeURIComponent(stackName)}/git-source/sops-identities/${encodeURIComponent(deleteTarget.id)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ acknowledge_destructive: true }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err?.error === 'string' ? err.error : 'Could not delete identity');
        return;
      }
      toast.success('Identity deleted');
      setDeleteTarget(null);
      setDeleteImpact([]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete identity');
    } finally {
      setMutating(false);
    }
  };

  if (!linked) return null;

  const readinessLabel = data?.readiness.ready
    ? 'Ready'
    : data?.readiness.failureClass === 'missing_key'
      ? 'Missing key'
      : data?.readiness.failureClass === 'unsupported_backend'
        ? 'Unsupported'
        : 'Not ready';

  return (
    <>
      <div className="space-y-3" data-testid="git-source-secrets">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-stat-subtitle">
            Age identities decrypt SOPS files only in a short-lived overlay during Git apply, Git deploy, candidate validation, or rollback. Ciphertext stays in the repository and on disk.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading || disabled}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Readiness</span>
          <span className="rounded-full border border-card-border px-2 py-0.5 text-[11px] text-stat-subtitle" data-testid="git-source-secrets-readiness">
            {readinessLabel}
          </span>
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Encrypted source policy</p>
          <div className="flex flex-wrap gap-2 max-md:flex-col">
            <Button
              type="button"
              size="sm"
              variant={data?.encrypted_source_policy !== 'require_encrypted' ? 'default' : 'outline'}
              disabled={!canEdit || disabled || savingPolicy}
              onClick={() => void savePolicy('allow_plaintext')}
            >
              Allow plaintext secrets
            </Button>
            <Button
              type="button"
              size="sm"
              variant={data?.encrypted_source_policy === 'require_encrypted' ? 'default' : 'outline'}
              disabled={!canEdit || disabled || savingPolicy}
              onClick={() => void savePolicy('require_encrypted')}
            >
              Require SOPS encryption
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Recipients</p>
          {(data?.identities ?? []).length === 0 ? (
            <p className="text-xs text-stat-subtitle">No age identities on this node yet.</p>
          ) : (
            <ul className="space-y-2">
              {(data?.identities ?? []).map((identity) => (
                <li key={identity.id} className="flex items-start justify-between gap-2 rounded-lg border border-card-border bg-card p-2 max-md:flex-col">
                  <code className="break-all text-[11px] text-stat-subtitle">{identity.recipient}</code>
                  <div className="flex shrink-0 gap-1 max-md:w-full max-md:justify-end">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void copyRecipient(identity.recipient)} aria-label="Copy recipient">
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    {canEdit && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={disabled || mutating}
                          onClick={() => setRotateTarget(identity)}
                          aria-label="Rotate identity"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={disabled || mutating}
                          onClick={() => void requestDelete(identity)}
                          aria-label="Delete identity"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {canEdit && (
          <div className="space-y-2 max-md:space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={disabled || mutating} onClick={() => void generateIdentity()}>
                Generate identity
              </Button>
            </div>
            <textarea
              className="w-full rounded-lg border border-card-border bg-card p-2 font-mono text-[11px] text-stat-subtitle"
              rows={3}
              placeholder="Paste AGE-SECRET-KEY-1… to import"
              value={importValue}
              onChange={(e) => setImportValue(e.target.value)}
              disabled={disabled || mutating}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || mutating || !importValue.trim()}
              onClick={() => void importIdentity()}
            >
              Import identity
            </Button>
          </div>
        )}
      </div>

      <ConfirmModal
        open={rotateTarget !== null}
        onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
        kicker={`${stackName.toUpperCase()} · GIT · ROTATE KEY`}
        title="Rotate age identity"
        confirmLabel={mutating ? 'Rotating…' : 'Rotate'}
        confirming={mutating}
        onConfirm={() => void confirmRotate()}
      >
        <p className="text-sm text-stat-subtitle">
          Generates a new identity on this node. Existing SOPS files keep the old recipient until you re-encrypt them in Git.
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteImpact([]);
          }
        }}
        variant="destructive"
        kicker={`${stackName.toUpperCase()} · GIT · DELETE KEY`}
        title="Delete age identity"
        confirmLabel={mutating ? 'Deleting…' : 'Delete'}
        confirming={mutating}
        onConfirm={() => void confirmDelete()}
      >
        <p className="text-sm text-stat-subtitle">{impactSummary(deleteImpact)}</p>
      </ConfirmModal>
    </>
  );
}
