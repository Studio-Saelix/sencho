import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { FleetTabHeading } from '@/components/fleet/FleetEmptyState';
import type { CveSuppression } from '@/types/security';
import { useAuth } from '@/context/AuthContext';

const CVE_ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[\w-]{14,})$/;
const PAGE_SIZE = 8;

interface SuppressionFormState {
  cveId: string;
  pkgName: string;
  imagePattern: string;
  reason: string;
  expiresInDays: string;
}

const EMPTY_FORM: SuppressionFormState = {
  cveId: '',
  pkgName: '',
  imagePattern: '',
  reason: '',
  expiresInDays: '',
};

interface SuppressionsPanelProps {
  isReplica: boolean;
}

export function SuppressionsPanel({ isReplica }: SuppressionsPanelProps) {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<CveSuppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<SuppressionFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteRow, setDeleteRow] = useState<CveSuppression | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/security/suppressions', { localOnly: true });
      if (!res.ok) throw new Error('Failed to load suppressions');
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load suppressions:', err);
      toast.error('Failed to load suppressions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const needsPagination = rows.length > PAGE_SIZE;

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const cveId = form.cveId.trim();
    if (!CVE_ID_RE.test(cveId)) {
      toast.error('CVE must look like CVE-YYYY-NNNN or GHSA-xxxx-xxxx-xxxx.');
      return;
    }
    const reason = form.reason.trim();
    if (!reason) {
      toast.error('A reason is required.');
      return;
    }
    let expiresAt: number | null = null;
    const days = form.expiresInDays.trim();
    if (days) {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('Expiry must be a positive number of days or blank.');
        return;
      }
      expiresAt = Date.now() + n * 24 * 60 * 60 * 1000;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/security/suppressions', {
        method: 'POST',
        localOnly: true,
        body: JSON.stringify({
          cve_id: cveId,
          pkg_name: form.pkgName.trim() || null,
          image_pattern: form.imagePattern.trim() || null,
          reason,
          expires_at: expiresAt,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to create suppression');
      }
      toast.success('Suppression created');
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to create suppression');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    try {
      const res = await apiFetch(`/security/suppressions/${deleteRow.id}`, {
        method: 'DELETE',
        localOnly: true,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to delete suppression');
      }
      toast.success('Suppression removed');
      await load();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to delete suppression');
    } finally {
      setDeleteRow(null);
    }
  };

  const formatExpiry = (row: CveSuppression): string => {
    if (row.expires_at === null) return 'Never';
    const d = new Date(row.expires_at);
    return d.toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      <FleetTabHeading
        title="CVE suppressions"
        subtitle="Accept known-benign CVEs so they stop triggering alerts. Suppressions apply at read time across the fleet and never modify stored scan data."
        action={
          isAdmin && !isReplica ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1.5" />
              Add suppression
            </Button>
          ) : undefined
        }
      />

      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3">
      {needsPagination && !loading && rows.length > 0 && (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setPage(Math.max(0, safePage - 1))}
            disabled={safePage === 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
          </Button>
          <span className="text-xs font-mono tabular-nums text-stat-subtitle min-w-[3rem] text-center">
            {safePage + 1} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
            disabled={safePage >= totalPages - 1}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded" />
          <Skeleton className="h-10 w-full rounded" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-center py-6 text-xs text-muted-foreground">
          No suppressions yet. Accept a CVE from any scan result to silence it fleet-wide.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <ScrollArea className="max-h-[420px] pr-2">
          <ul className="divide-y divide-glass-border">
            {pageItems.map((row) => (
              <li key={row.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium">{row.cve_id}</span>
                    {row.pkg_name && (
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {row.pkg_name}
                      </Badge>
                    )}
                    {row.image_pattern && (
                      <Badge variant="outline" className="text-[10px] font-mono truncate max-w-[220px]">
                        {row.image_pattern}
                      </Badge>
                    )}
                    {!row.active && (
                      <Badge variant="secondary" className="text-[10px]">expired</Badge>
                    )}
                    {row.replicated_from_control === 1 && (
                      <Badge variant="secondary" className="text-[10px]">replicated</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-2">{row.reason}</div>
                  <div className="text-[11px] font-mono text-stat-subtitle">
                    by {row.created_by} - expires {formatExpiry(row)}
                  </div>
                </div>
                {isAdmin && !isReplica && row.replicated_from_control === 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground shrink-0"
                    onClick={() => setDeleteRow(row)}
                    title="Remove suppression"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
      </div>

      <Modal open={dialogOpen} onOpenChange={setDialogOpen} size="md">
        <ModalHeader
          kicker="SUPPRESSIONS · NEW"
          title="New suppression"
          description="Accept a CVE as known-benign so it stops triggering alerts across the fleet."
        />
        <ModalBody>
          <div className="space-y-2">
            <Label htmlFor="s-cve">CVE or advisory ID</Label>
            <Input
              id="s-cve"
              placeholder="CVE-2024-12345 or GHSA-xxxx-xxxx-xxxx"
              value={form.cveId}
              onChange={(e) => setForm({ ...form, cveId: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s-pkg">Package (optional)</Label>
            <Input
              id="s-pkg"
              placeholder="e.g. openssl (leave blank to match every package)"
              value={form.pkgName}
              onChange={(e) => setForm({ ...form, pkgName: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s-image">Image pattern (optional)</Label>
            <Input
              id="s-image"
              placeholder="e.g. registry.internal/* (leave blank for all images)"
              value={form.imagePattern}
              onChange={(e) => setForm({ ...form, imagePattern: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s-reason">Reason</Label>
            <textarea
              id="s-reason"
              className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Why is this CVE safe to accept?"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s-expiry">Expires in (days, optional)</Label>
            <Input
              id="s-expiry"
              type="number"
              min="1"
              placeholder="Leave blank for no expiry"
              value={form.expiresInDays}
              onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}
            />
          </div>
        </ModalBody>
        <ModalFooter
          secondary={
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
          }
          primary={
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Create'}
            </Button>
          }
        />
      </Modal>

      <ConfirmModal
        open={deleteRow !== null}
        onOpenChange={(open) => !open && setDeleteRow(null)}
        variant="destructive"
        kicker="SUPPRESSIONS · REMOVE · IRREVERSIBLE"
        title="Remove suppression"
        confirmLabel="Remove"
        onConfirm={handleDelete}
      >
        <p className="text-sm text-stat-subtitle">
          Future scan results will surface <span className="font-mono font-medium text-stat-value">{deleteRow?.cve_id}</span> again wherever it applies.
        </p>
      </ConfirmModal>
    </div>
  );
}
