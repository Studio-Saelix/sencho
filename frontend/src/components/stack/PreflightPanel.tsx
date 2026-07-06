import { useEffect, useMemo, useState } from 'react';
import {
  Check, TriangleAlert, ShieldAlert, Info, RefreshCw, Stethoscope, X,
  ChevronDown, ChevronRight, ShieldCheck, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';
import { usePreflightDismiss } from '@/hooks/usePreflightDismiss';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';

type PreflightSeverity = 'blocker' | 'high' | 'warning' | 'info';
type PreflightStatus = 'never-run' | 'pass' | 'unrenderable' | PreflightSeverity;
type PreflightAckExpiryMode = 'forever' | 'until_compose_change' | 'days' | 'until_image_change';

interface PreflightFinding {
  ruleId: string;
  severity: PreflightSeverity;
  title: string;
  message: string;
  sourcePath?: string;
  remediation?: string;
  service?: string;
  acknowledged?: boolean;
  acknowledgementId?: number;
  acknowledgementReason?: string;
  acknowledgementExpiry?: PreflightAckExpiryMode;
}

interface PreflightReport {
  stack: string;
  ranAt: number | null;
  ranBy: string | null;
  renderable: boolean;
  renderError: string | null;
  status: PreflightStatus;
  highestSeverity: PreflightSeverity | null;
  activeStatus: PreflightStatus;
  activeHighestSeverity: PreflightSeverity | null;
  activeCount: number;
  acknowledgedCount: number;
  findings: PreflightFinding[];
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const MODAL_FIELD_LABEL = LABEL_CLASS;
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const SEVERITY_META: Record<PreflightSeverity, { label: string; icon: LucideIcon; tone: string }> = {
  blocker: { label: 'blocker', icon: ShieldAlert, tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive' },
  high: { label: 'high risk', icon: TriangleAlert, tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  warning: { label: 'warning', icon: Info, tone: 'border-info/40 bg-info/[0.06] text-info' },
  info: { label: 'info', icon: Info, tone: 'border-muted bg-card/40 text-stat-subtitle' },
};

const GROUP_ORDER: PreflightSeverity[] = ['blocker', 'high', 'warning', 'info'];

const EXPIRY_LABELS: Record<PreflightAckExpiryMode, string> = {
  forever: 'Forever',
  until_compose_change: 'Until Compose changes',
  days: '30 days',
  until_image_change: 'Until image changes',
};

function summaryMeta(report: PreflightReport): { label: string; icon: LucideIcon; tone: string; line: string } {
  if (!report.renderable) {
    return {
      label: 'cannot render',
      icon: ShieldAlert,
      tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
      line: report.renderError ?? 'Sencho could not render the effective Compose model.',
    };
  }
  if (report.activeCount === 0 && report.acknowledgedCount === 0) {
    return { label: 'all clear', icon: Check, tone: 'border-success/40 bg-success/[0.06] text-success', line: 'No issues found in the effective model.' };
  }
  const meta = SEVERITY_META[report.activeHighestSeverity ?? 'info'];
  const activeParts = GROUP_ORDER
    .map(sev => ({ sev, n: report.findings.filter(f => !f.acknowledged && f.severity === sev).length }))
    .filter(c => c.n > 0)
    .map(c => `${c.n} ${SEVERITY_META[c.sev].label}`)
    .join(' · ');
  const line = report.acknowledgedCount > 0
    ? `${report.activeCount} active${activeParts ? ` (${activeParts})` : ''} · ${report.acknowledgedCount} acknowledged`
    : (activeParts || `${report.activeCount} active`);
  return { label: report.activeCount === 0 ? 'acknowledged' : meta.label, icon: report.activeCount === 0 ? ShieldCheck : meta.icon, tone: report.activeCount === 0 ? 'border-muted bg-card/40 text-stat-subtitle' : meta.tone, line };
}

function expiryComboboxOptions(finding: PreflightFinding): ComboboxOption[] {
  const options: ComboboxOption[] = [
    { value: 'forever', label: EXPIRY_LABELS.forever },
    { value: 'until_compose_change', label: EXPIRY_LABELS.until_compose_change },
    { value: 'days', label: EXPIRY_LABELS.days },
  ];
  if (finding.service) {
    options.push({ value: 'until_image_change', label: EXPIRY_LABELS.until_image_change });
  }
  return options;
}

function FindingRow({
  finding,
  canEdit,
  onAcknowledge,
}: {
  finding: PreflightFinding;
  canEdit: boolean;
  onAcknowledge?: (finding: PreflightFinding) => void;
}) {
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {finding.service && (
            <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{finding.service}</span>
          )}
          <span className="text-[12px] font-medium text-foreground/90">{finding.title}</span>
        </div>
        {canEdit && onAcknowledge && (
          <button
            type="button"
            data-testid={`preflight-ack-btn-${finding.ruleId}-${finding.service ?? 'stack'}`}
            onClick={() => onAcknowledge(finding)}
            className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand"
          >
            acknowledge
          </button>
        )}
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-foreground/80">{finding.message}</div>
      {finding.remediation && (
        <div className="mt-1 text-[11px] text-stat-subtitle">
          <span className="font-mono text-[10px] uppercase tracking-wide">fix</span> · {finding.remediation}
        </div>
      )}
      {finding.sourcePath && (
        <div className="mt-0.5 font-mono text-[10px] text-stat-subtitle">{finding.sourcePath}</div>
      )}
    </div>
  );
}

function AcknowledgedRow({
  finding,
  canEdit,
  onClear,
}: {
  finding: PreflightFinding;
  canEdit: boolean;
  onClear: (finding: PreflightFinding) => void;
}) {
  return (
    <div className="border-t border-muted py-2 first:border-t-0 opacity-80">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {finding.service && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-stat-subtitle">{finding.service}</span>
            )}
            <span className="text-[12px] font-medium text-foreground/80">{finding.title}</span>
          </div>
          {finding.acknowledgementReason && (
            <div className="mt-1 text-[11px] text-stat-subtitle">{finding.acknowledgementReason}</div>
          )}
          {finding.acknowledgementExpiry && (
            <div className="mt-0.5 font-mono text-[10px] text-stat-subtitle">
              expires: {EXPIRY_LABELS[finding.acknowledgementExpiry]}
            </div>
          )}
        </div>
        {canEdit && finding.acknowledgementId != null && (
          <button
            type="button"
            data-testid={`preflight-clear-ack-${finding.acknowledgementId}`}
            onClick={() => onClear(finding)}
            className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}

export default function PreflightPanel({ stackName, canEdit = false }: { stackName: string; canEdit?: boolean }) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackTarget, setAckTarget] = useState<PreflightFinding | null>(null);
  const [ackReason, setAckReason] = useState('');
  const [ackExpiry, setAckExpiry] = useState<PreflightAckExpiryMode>('forever');
  const [ackSaving, setAckSaving] = useState(false);
  const [clearTarget, setClearTarget] = useState<PreflightFinding | null>(null);
  const [clearing, setClearing] = useState(false);
  const [ackSectionOpen, setAckSectionOpen] = useState(false);

  const refreshReport = async () => {
    try {
      const res = await apiFetch(`/stacks/${stackName}/preflight`);
      if (!res.ok) {
        toast.error('Failed to refresh the preflight report.');
        return;
      }
      setReport((await res.json()) as PreflightReport);
      setLoadError(false);
    } catch {
      toast.error('Failed to refresh the preflight report.');
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/preflight`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the preflight report.');
          return;
        }
        setReport((await res.json()) as PreflightReport);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the preflight report.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  const runPreflight = async () => {
    setRunning(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/preflight/run`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to run preflight.');
        return;
      }
      setReport((await res.json()) as PreflightReport);
      setLoadError(false);
    } catch {
      toast.error('Failed to run preflight.');
    } finally {
      setRunning(false);
    }
  };

  const activeFindings = useMemo(
    () => report?.findings.filter(f => !f.acknowledged) ?? [],
    [report?.findings],
  );
  const acknowledgedFindings = useMemo(
    () => report?.findings.filter(f => f.acknowledged) ?? [],
    [report?.findings],
  );

  const summary = report && report.status !== 'never-run' ? summaryMeta(report) : null;
  const SummaryIcon = summary?.icon;
  const busy = loading || running;

  const { dismissed, dismiss } = usePreflightDismiss(stackName, nodeId, activeFindings);
  const hasActiveFindings = activeFindings.length > 0;

  const openAckDialog = (finding: PreflightFinding) => {
    setAckTarget(finding);
    setAckReason('');
    setAckExpiry('forever');
    setAckOpen(true);
  };

  const submitAck = async () => {
    if (!ackTarget) return;
    setAckSaving(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/preflight/acknowledgements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleId: ackTarget.ruleId,
          service: ackTarget.service ?? null,
          reason: ackReason.trim(),
          expiryMode: ackExpiry,
          expiresInDays: ackExpiry === 'days' ? 30 : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        toast.error(data.error ?? 'Failed to acknowledge the finding.');
        return;
      }
      setAckOpen(false);
      setAckTarget(null);
      await refreshReport();
      toast.success('Finding acknowledged.');
    } catch {
      toast.error('Failed to acknowledge the finding.');
    } finally {
      setAckSaving(false);
    }
  };

  const confirmClear = async () => {
    if (!clearTarget?.acknowledgementId) return;
    setClearing(true);
    try {
      const res = await apiFetch(
        `/stacks/${stackName}/preflight/acknowledgements/${clearTarget.acknowledgementId}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 204) {
        toast.error('Failed to clear the acknowledgement.');
        return;
      }
      setClearTarget(null);
      await refreshReport();
      toast.success('Acknowledgement cleared.');
    } catch {
      toast.error('Failed to clear the acknowledgement.');
    } finally {
      setClearing(false);
    }
  };

  const ackExpiryOptions = ackTarget ? expiryComboboxOptions(ackTarget) : [{ value: 'forever', label: EXPIRY_LABELS.forever }];

  return (
    <div data-testid="preflight-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose doctor</span>
        <button
          type="button"
          data-testid="preflight-run-btn"
          onClick={runPreflight}
          disabled={busy}
          className={ACTION_CLASS}
        >
          <RefreshCw className={cn('h-3 w-3', running && 'animate-spin')} strokeWidth={1.5} /> run preflight
        </button>
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the preflight report.</span>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
          >
            retry
          </button>
        </div>
      ) : !report ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Loading preflight…</div>
      ) : report.status === 'never-run' ? (
        <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-col items-start gap-2')}>
          <div className="flex items-center gap-2 text-stat-subtitle">
            <Stethoscope className="h-4 w-4" strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-wide">no preflight yet</span>
          </div>
          <p className="text-[12px] leading-relaxed text-foreground/80">
            Run preflight to render the effective model and check this stack for common deploy problems before you apply it.
          </p>
        </div>
      ) : (
        <>
          {summary && SummaryIcon && !dismissed && (
            <div data-testid="preflight-status" data-status={report.activeStatus} className={cn(CARD_CLASS, summary.tone, 'relative')}>
              {hasActiveFindings && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={dismiss}
                        data-testid="preflight-dismiss-btn"
                        aria-label="Dismiss until findings change"
                        className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded text-current/70 hover:bg-current/10 hover:text-current"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Dismiss until findings change</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <div className="flex items-center gap-2 pr-6">
                <SummaryIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{summary.label}</span>
                {report.ranAt && (
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    · ran {formatTimeAgo(report.ranAt)}{report.ranBy ? ` by ${report.ranBy}` : ''}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{summary.line}</div>
            </div>
          )}

          {GROUP_ORDER.map(sev => {
            const items = activeFindings.filter(f => f.severity === sev);
            if (items.length === 0) return null;
            return (
              <section key={sev}>
                <div className={cn(LABEL_CLASS, 'mb-1.5')}>{SEVERITY_META[sev].label} · {items.length}</div>
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {items.map((f, i) => (
                    <FindingRow
                      key={`${f.ruleId}-${f.service ?? ''}-${i}`}
                      finding={f}
                      canEdit={canEdit}
                      onAcknowledge={openAckDialog}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {acknowledgedFindings.length > 0 && (
            <section data-testid="preflight-acknowledged-section">
              <button
                type="button"
                onClick={() => setAckSectionOpen(v => !v)}
                className={cn(LABEL_CLASS, 'mb-1.5 inline-flex items-center gap-1 hover:text-brand')}
              >
                {ackSectionOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                acknowledged · {acknowledgedFindings.length}
              </button>
              {ackSectionOpen && (
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {acknowledgedFindings.map((f, i) => (
                    <AcknowledgedRow
                      key={`ack-${f.acknowledgementId ?? i}`}
                      finding={f}
                      canEdit={canEdit}
                      onClear={setClearTarget}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <Modal open={ackOpen} onOpenChange={setAckOpen} size="md">
        <ModalHeader
          kicker="COMPOSE DOCTOR · ACKNOWLEDGE"
          title="Accept this finding"
          description="Accept a Compose Doctor finding for this stack."
        />
        <ModalBody>
          {ackTarget && (
            <div className="rounded-md border border-card-border bg-card/40 px-3 py-2 font-mono text-[12px] text-foreground/80">
              {ackTarget.title}
              {ackTarget.service ? ` · ${ackTarget.service}` : ''}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="preflight-ack-reason" className={MODAL_FIELD_LABEL}>Note (optional)</Label>
            <textarea
              id="preflight-ack-reason"
              className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
              placeholder="Why is this finding acceptable for this stack?"
              value={ackReason}
              onChange={(e) => setAckReason(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="preflight-ack-expiry" className={MODAL_FIELD_LABEL}>Show again when</Label>
            <Combobox
              id="preflight-ack-expiry"
              options={ackExpiryOptions}
              value={ackExpiry}
              onValueChange={(value) => setAckExpiry(value as PreflightAckExpiryMode)}
              placeholder="Select expiry"
              disabled={ackSaving}
              className="w-full"
            />
            {ackExpiry === 'until_image_change' && (
              <p className="text-[11px] leading-relaxed text-stat-subtitle">
                Re-surfaces when the service image reference changes in the effective model, not on silent digest re-pulls.
              </p>
            )}
          </div>
        </ModalBody>
        <ModalFooter
          hint="SHOW AGAIN"
          hintAccent={EXPIRY_LABELS[ackExpiry]}
          secondary={(
            <Button variant="outline" size="sm" onClick={() => setAckOpen(false)} disabled={ackSaving}>
              Cancel
            </Button>
          )}
          primary={(
            <Button size="sm" onClick={submitAck} disabled={ackSaving}>
              {ackSaving ? 'Saving…' : 'Acknowledge'}
            </Button>
          )}
        />
      </Modal>

      <ConfirmModal
        open={clearTarget !== null}
        onOpenChange={(open) => { if (!open) setClearTarget(null); }}
        kicker="COMPOSE DOCTOR · CLEAR"
        title="Clear acknowledgement"
        description="Clear a Compose Doctor acknowledgement for this stack."
        hint="RESTORES active finding"
        confirmLabel="Clear"
        confirming={clearing}
        onConfirm={confirmClear}
      >
        <p className="text-sm text-stat-subtitle">
          This finding will count as active again on the next preflight read.
        </p>
      </ConfirmModal>
    </div>
  );
}
