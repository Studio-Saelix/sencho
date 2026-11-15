import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check, TriangleAlert, ShieldAlert, Info, RefreshCw, Stethoscope, X,
  ChevronDown, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';
import { preflightFingerprint, useStackDismiss } from '@/hooks/useStackDismiss';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath } from '@/components/ui/status-path';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import type { StatusTone } from '@/lib/statusTone';
import { IconBusyButton } from '@/components/ui/icon-busy-button';
import { Label } from '@/components/ui/label';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { isPreflightNoteFinding } from '@/lib/preflightNotes';
import { coverageGapLine, type AssuranceCoverage } from '@/lib/coverageGaps';
import { SourceLocationLink } from '@/components/ui/source-location-link';
import type { AuthoredLocation } from '@/lib/authoredLocation';

type PreflightSeverity = 'blocker' | 'high' | 'warning' | 'info';
type PreflightStatus = 'never-run' | 'pass' | 'unrenderable' | PreflightSeverity;
type PreflightAckExpiryMode = 'forever' | 'until_compose_change' | 'days' | 'until_image_change';

interface PreflightFinding {
  ruleId: string;
  severity: PreflightSeverity;
  title: string;
  message: string;
  sourcePath?: string;
  /** Authored file and range, when one source could be decided. */
  location?: AuthoredLocation;
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
  coverage?: AssuranceCoverage;
}

/** A finding's stable identity across two reads: a read can only drop or move
 *  its location, while a new run can replace the finding altogether. */
function sameFinding(a: PreflightFinding, b: PreflightFinding): boolean {
  return a.ruleId === b.ruleId
    && (a.service ?? null) === (b.service ?? null)
    && (a.sourcePath ?? null) === (b.sourcePath ?? null)
    && a.message === b.message;
}

function sameRange(a: AuthoredLocation | undefined, b: AuthoredLocation | undefined): boolean {
  if (!a || !b) return a === b;
  return a.file === b.file && a.line === b.line && a.column === b.column
    && a.endLine === b.endLine && a.endColumn === b.endColumn;
}

/** The finding a click belongs to in a fresh report. When several stored
 *  findings render the same identity (for example one bind source mounted at
 *  two targets), the clicked range is the only discriminator: a candidate
 *  anchored at the clicked range opens that range, even when several rows
 *  share it. With no anchor the click cannot choose, so the caller says
 *  whether the refreshed report still has a link to choose from. */
type FreshFinding =
  | { kind: 'found'; finding: PreflightFinding }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; hasLink: boolean };

function freshFinding(report: PreflightReport, finding: PreflightFinding): FreshFinding {
  const candidates = report.findings.filter(candidate => sameFinding(candidate, finding));
  if (candidates.length === 0) return { kind: 'missing' };
  if (candidates.length === 1) return { kind: 'found', finding: candidates[0] };
  // Every anchored candidate has the clicked range, so opening any of them
  // lands on the same place; only a range that anchors none is ambiguous.
  const anchored = candidates.filter(candidate => sameRange(candidate.location, finding.location));
  if (anchored.length > 0) return { kind: 'found', finding: anchored[0] };
  return { kind: 'ambiguous', hasLink: candidates.some(candidate => candidate.location !== undefined && !candidate.acknowledged) };
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const MODAL_FIELD_LABEL = LABEL_CLASS;
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const ACTION_BUTTON_CLASS = cn(ACTION_CLASS, 'h-auto rounded-none p-0 font-normal hover:bg-transparent [&_svg]:size-3');

const SEVERITY_META: Record<PreflightSeverity, { label: string; icon: LucideIcon; tone: StatusTone }> = {
  blocker: { label: 'blocker', icon: ShieldAlert, tone: 'destructive' },
  high: { label: 'high risk', icon: TriangleAlert, tone: 'warning' },
  warning: { label: 'warning', icon: Info, tone: 'brand' },
  info: { label: 'info', icon: Info, tone: 'neutral' },
};

const GROUP_ORDER: PreflightSeverity[] = ['blocker', 'high', 'warning', 'info'];

const EXPIRY_LABELS: Record<PreflightAckExpiryMode, string> = {
  forever: 'Forever',
  until_compose_change: 'Until Compose changes',
  days: '30 days',
  until_image_change: 'Until image changes',
};

const NEUTRAL_SUMMARY = { icon: Info, tone: 'neutral' } as const;

interface SummaryMeta {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
  line: string;
  /** The run itself is the fix: the Answer carries the Run preflight verb. */
  rerun: boolean;
}

function summaryMeta(report: PreflightReport): SummaryMeta {
  if (!report.renderable) {
    return {
      label: 'cannot render',
      icon: ShieldAlert,
      tone: 'destructive',
      // The render-failed finding below already carries the error text; say it once.
      line: report.renderError && !report.findings.some(f => f.message === report.renderError)
        ? report.renderError
        : 'Sencho could not render the effective Compose model. The cause is listed below.',
      rerun: false,
    };
  }
  if (report.activeCount === 0) {
    // A clean result only reads as "all clear" when every verdict-affecting
    // check ran. Unrecorded coverage (an older run or an older node) and a run
    // with skipped checks are reported as what they are: not a clean bill.
    if (!report.coverage || report.coverage.state === 'unrecorded') {
      return {
        label: `${report.activeStatus} · coverage not recorded`,
        icon: NEUTRAL_SUMMARY.icon,
        tone: NEUTRAL_SUMMARY.tone,
        line: 'This run did not record which checks ran.',
        rerun: true,
      };
    }
    const gap = coverageGapLine(report.coverage);
    if (gap) {
      return {
        label: 'partial check',
        icon: NEUTRAL_SUMMARY.icon,
        tone: NEUTRAL_SUMMARY.tone,
        line: `No issues in the checks that ran. ${gap}`,
        rerun: true,
      };
    }
    const acknowledgedOnly = report.acknowledgedCount > 0;
    return {
      label: acknowledgedOnly ? 'all clear · findings acknowledged' : 'all clear',
      icon: Check,
      tone: 'success',
      line: acknowledgedOnly
        ? 'No active findings remain.'
        : 'No issues found in the effective model.',
      rerun: false,
    };
  }
  const meta = SEVERITY_META[report.activeHighestSeverity ?? 'info'];
  // Per-severity and acknowledged counts live in the group headers below.
  const line = `${report.activeCount} active ${report.activeCount === 1 ? 'finding' : 'findings'}`;
  return { label: meta.label, icon: meta.icon, tone: meta.tone, line, rerun: false };
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
  onOpenLocation,
}: {
  finding: PreflightFinding;
  canEdit: boolean;
  onAcknowledge?: (finding: PreflightFinding) => void;
  onOpenLocation?: (finding: PreflightFinding) => void;
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
      {finding.location && onOpenLocation ? (
        <div className="mt-0.5">
          <SourceLocationLink location={finding.location} onOpen={() => onOpenLocation(finding)} />
        </div>
      ) : finding.sourcePath ? (
        <div className="mt-0.5 font-mono text-[10px] text-stat-subtitle">{finding.sourcePath}</div>
      ) : null}
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

function PreflightSkeleton() {
  return (
    <div data-testid="preflight-skeleton" role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading preflight</span>
      <Skeleton className="h-14 w-full" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

function RunPreflightButton({ pending, onRun }: { pending: boolean; onRun: () => void }) {
  return (
    <BusyButton
      size="sm"
      variant="outline"
      data-testid="preflight-run-answer-btn"
      pending={pending}
      busyLabel="Running…"
      className="h-7 rounded-lg max-md:h-11"
      onClick={onRun}
    >
      Run preflight
    </BusyButton>
  );
}

export default function PreflightPanel({
  stackName,
  canEdit = false,
  onOpenLocation,
}: {
  stackName: string;
  canEdit?: boolean;
  onOpenLocation?: (location: AuthoredLocation) => void;
}) {
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
  const locationRequest = useRef(0);
  // The click-time read belongs to the stack and node it was opened on. A
  // pending response must not land in the panel after the operator moves on.
  const locationScope = useRef({ stackName, nodeId });
  useLayoutEffect(() => {
    locationScope.current = { stackName, nodeId };
  }, [stackName, nodeId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadReport = async (): Promise<PreflightReport> => {
    const res = await apiFetch(`/stacks/${stackName}/preflight`);
    if (!res.ok) throw new Error('Failed to load the preflight report.');
    return (await res.json()) as PreflightReport;
  };

  const refreshReport = async () => {
    try {
      setReport(await loadReport());
      setLoadError(false);
    } catch {
      toast.error('Failed to refresh the preflight report.');
    }
  };

  /**
   * A rendered link is a fact about the report as it was read, not about the
   * file now. Re-read the report on the way to the editor so the click opens
   * the range the current file actually has; when the fresh read can no longer
   * locate the finding, open nothing rather than a stale line. A later click
   * supersedes an earlier one still in flight, so an out-of-order response
   * cannot reopen the range the operator moved away from.
   */
  const openFindingLocation = async (finding: PreflightFinding) => {
    if (!onOpenLocation) return;
    const request = ++locationRequest.current;
    const scope = { stackName, nodeId };
    try {
      const fresh = await loadReport();
      if (request !== locationRequest.current
        || !mounted.current
        || locationScope.current.stackName !== scope.stackName
        || locationScope.current.nodeId !== scope.nodeId) return;
      setReport(fresh);
      setLoadError(false);
      const current = freshFinding(fresh, finding);
      if (current.kind === 'ambiguous') {
        // Several findings share the identity and the clicked range picks none
        // of them; name a visible link only when the refreshed report has one.
        toast.info(current.hasLink
          ? 'The report now has more than one matching finding. Choose the link from the current report.'
          : 'The report was refreshed; several findings match and none shows a link.');
        return;
      }
      if (current.kind === 'missing' || !current.finding.location) {
        toast.info('This location is no longer current. The report was refreshed and no longer shows a link for this finding.');
        return;
      }
      onOpenLocation(current.finding.location);
    } catch {
      toast.error('Could not confirm this location is still current.');
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

  const { activeFindings, noteFindings, acknowledgedFindings } = useMemo(() => {
    const notes: PreflightFinding[] = [];
    const active: PreflightFinding[] = [];
    const acknowledged: PreflightFinding[] = [];
    for (const f of report?.findings ?? []) {
      if (isPreflightNoteFinding(f.ruleId)) notes.push(f);
      else if (f.acknowledged) acknowledged.push(f);
      else active.push(f);
    }
    return { activeFindings: active, noteFindings: notes, acknowledgedFindings: acknowledged };
  }, [report?.findings]);

  const summary = report && report.status !== 'never-run' ? summaryMeta(report) : null;
  const busy = loading || running;
  // The Answer carries its own Run preflight verb when the run is the fix, so the
  // header button would be the same action twice on one surface.
  const answerRuns = !loadError && !!report && (report.status === 'never-run' || !!summary?.rerun);
  const { showBusy: showSkeleton } = useVisualBusy(loading && !report);

  const activeFingerprint = useMemo(() => preflightFingerprint(activeFindings), [activeFindings]);
  const { dismissed, dismiss } = useStackDismiss('doctor', stackName, nodeId, activeFingerprint);
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
        {!answerRuns && (
          <IconBusyButton
            data-testid="preflight-run-btn"
            variant="ghost"
            icon={RefreshCw}
            label="run preflight"
            pending={busy}
            onClick={runPreflight}
            className={ACTION_BUTTON_CLASS}
          />
        )}
      </div>

      {loadError ? (
        <StatusPath
          stages={[]}
          answer={{
            tone: 'destructive',
            icon: ShieldAlert,
            title: 'could not load',
            line: 'Could not load the preflight report.',
            action: (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="preflight-retry-btn"
                disabled={loading}
                className="h-7 rounded-lg max-md:h-11"
                onClick={() => setReloadKey(k => k + 1)}
              >
                Retry
              </Button>
            ),
          }}
        />
      ) : !report ? (
        showSkeleton ? <PreflightSkeleton /> : null
      ) : report.status === 'never-run' ? (
        <StatusPath
          stages={[]}
          data-testid="preflight-never-run"
          answer={{
            tone: 'neutral',
            icon: Stethoscope,
            title: 'no preflight yet',
            line: 'Render the effective model and check this stack for common deploy problems before you apply it.',
            action: <RunPreflightButton pending={busy} onRun={runPreflight} />,
          }}
        />
      ) : (
        <>
          {summary && !dismissed && (
            <StatusPath
              stages={[]}
              answer={{
                'data-testid': 'preflight-status',
                tone: summary.tone,
                icon: summary.icon,
                title: summary.label,
                line: summary.line,
                status: report.activeStatus,
                detail: report.ranAt ? `Ran ${formatTimeAgo(report.ranAt)}${report.ranBy ? ` by ${report.ranBy}` : ''}` : null,
                action: summary.rerun ? (
                  <RunPreflightButton pending={busy} onRun={runPreflight} />
                ) : hasActiveFindings ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={dismiss}
                          data-testid="preflight-dismiss-btn"
                          aria-label="Dismiss until findings change"
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-current/70 hover:bg-current/10 hover:text-current max-md:h-11 max-md:w-11"
                        >
                          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Dismiss until findings change</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : undefined,
              }}
            />
          )}

          {noteFindings.length > 0 && (
            <section data-testid="preflight-notes-section">
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>notes · {noteFindings.length}</div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {noteFindings.map((f, i) => (
                  <FindingRow
                    key={`note-${f.ruleId}-${f.service ?? ''}-${i}`}
                    finding={f}
                    canEdit={false}
                    onOpenLocation={(target) => { void openFindingLocation(target); }}
                  />
                ))}
              </div>
            </section>
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
                      onOpenLocation={(target) => { void openFindingLocation(target); }}
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
