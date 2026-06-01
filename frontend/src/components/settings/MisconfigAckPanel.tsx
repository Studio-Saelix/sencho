import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { ChevronLeft, ChevronRight, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import type { MisconfigAcknowledgement } from '@/types/security';
import { useAuth } from '@/context/AuthContext';

const RULE_RE = /^[A-Z0-9][A-Z0-9_-]{0,199}$/i;
const PAGE_SIZE = 8;

interface AckFormState {
  ruleId: string;
  stackPattern: string;
  reason: string;
  expiresInDays: string;
}

const EMPTY_FORM: AckFormState = {
  ruleId: '',
  stackPattern: '',
  reason: '',
  expiresInDays: '',
};

interface MisconfigAckPanelProps {
  isReplica: boolean;
}

export function MisconfigAckPanel({ isReplica }: MisconfigAckPanelProps) {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<MisconfigAcknowledgement[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AckFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteRow, setDeleteRow] = useState<MisconfigAcknowledgement | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/security/misconfig-acks', { localOnly: true });
      if (!res.ok) throw new Error('Failed to load acknowledgements');
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load misconfig acknowledgements:', err);
      toast.error('Failed to load acknowledgements');
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
    const ruleId = form.ruleId.trim();
    if (!RULE_RE.test(ruleId)) {
      toast.error('Rule id must be alpha-numeric (e.g. "DS002" or "AVD-DS-0002").');
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
      const res = await apiFetch('/security/misconfig-acks', {
        method: 'POST',
        localOnly: true,
        body: JSON.stringify({
          rule_id: ruleId,
          stack_pattern: form.stackPattern.trim() || null,
          reason,
          expires_at: expiresAt,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to create acknowledgement');
      }
      toast.success('Acknowledgement created');
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to create acknowledgement');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    try {
      const res = await apiFetch(`/security/misconfig-acks/${deleteRow.id}`, {
        method: 'DELETE',
        localOnly: true,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to delete acknowledgement');
      }
      toast.success('Acknowledgement removed');
      await load();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to delete acknowledgement');
    } finally {
      setDeleteRow(null);
    }
  };

  const formatExpiry = (row: MisconfigAcknowledgement): string => {
    if (row.expires_at === null) return 'Never';
    const d = new Date(row.expires_at);
    return d.toLocaleDateString();
  };

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
          <span className="font-medium text-sm">Misconfig Acknowledgements</span>
          <Badge variant="outline" className="text-[10px] shrink-0 font-mono tabular-nums">
            {rows.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {needsPagination && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
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
              >
                <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
              </Button>
            </>
          )}
          {isAdmin && !isReplica && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1.5" />
              Add Acknowledgement
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Accept known-benign misconfigurations so they stop triggering alerts. Acknowledgements apply at read time
        across every instance in the fleet and never modify stored scan data.
      </p>

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded" />
          <Skeleton className="h-10 w-full rounded" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-center py-6 text-xs text-muted-foreground">
          No acknowledgements yet. Acknowledge a misconfig from any scan result to silence it fleet-wide.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <ScrollArea className="max-h-[420px] pr-2">
          <ul className="divide-y divide-glass-border">
            {pageItems.map((row) => (
              <li key={row.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium">{row.rule_id}</span>
                    {row.stack_pattern && (
                      <Badge variant="outline" className="text-[10px] font-mono truncate max-w-[220px]">
                        {row.stack_pattern}
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
                    by {row.created_by} · expires {formatExpiry(row)}
                  </div>
                </div>
                {isAdmin && !isReplica && row.replicated_from_control === 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground shrink-0"
                    onClick={() => setDeleteRow(row)}
                    title="Remove acknowledgement"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      <Modal open={dialogOpen} onOpenChange={setDialogOpen} size="md">
        <ModalHeader
          kicker="ACKNOWLEDGEMENTS · NEW"
          title="New misconfig acknowledgement"
          description="Accept a known-benign misconfiguration so it stops triggering alerts across the fleet."
        />
        <ModalBody>
          <div className="space-y-2">
            <Label htmlFor="ack-rule">Rule id</Label>
            <Input
              id="ack-rule"
              placeholder="DS002 or AVD-DS-0002"
              value={form.ruleId}
              onChange={(e) => setForm({ ...form, ruleId: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ack-stack">Stack pattern (optional)</Label>
            <Input
              id="ack-stack"
              placeholder="e.g. traefik or web-* (leave blank to match every stack)"
              value={form.stackPattern}
              onChange={(e) => setForm({ ...form, stackPattern: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ack-reason">Reason</Label>
            <textarea
              id="ack-reason"
              className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Why is this misconfiguration safe to accept?"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ack-expiry">Expires in (days, optional)</Label>
            <Input
              id="ack-expiry"
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
        kicker="ACKNOWLEDGEMENTS · REMOVE · IRREVERSIBLE"
        title="Remove acknowledgement"
        confirmLabel="Remove"
        onConfirm={handleDelete}
      >
        <p className="text-sm text-stat-subtitle">
          Future scan results will surface <span className="font-mono font-medium text-stat-value">{deleteRow?.rule_id}</span> again wherever it applies.
        </p>
      </ConfirmModal>
    </div>
  );
}
