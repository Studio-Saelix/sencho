import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FindingRowActions } from '@/components/ui/finding-row-actions';
import type { DismissalMode } from '@/types/findingDismissal';
import { isDismissableDriftFinding, type StackDriftFinding } from '@/types/drift';
import { DRIFT_FINDING_LABEL } from './driftLabels';
import type { DriftResolution, DriftVerb } from './driftVerbs';

/** What the panel wires into every finding row so each verb has one handler. */
export interface DriftRowControls {
  run: (finding: StackDriftFinding, verb: DriftVerb) => void;
  isBusy: (finding: StackDriftFinding, verb: DriftVerb) => boolean;
  /** Mirrors the dismissal route's guard (`stack:deploy` on the stack). */
  canDismiss: boolean;
  isDismissing: (finding: StackDriftFinding) => boolean;
  onDismiss: (finding: StackDriftFinding, mode: DismissalMode, days?: number) => void;
}

const VERB_CLASS = 'h-7 px-2 text-xs max-md:min-h-11';

function VerbButton({ verb, busy, onClick }: { verb: DriftVerb; busy: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={VERB_CLASS}
      disabled={busy}
      data-testid={`drift-verb-${verb.kind}`}
      onClick={onClick}
    >
      {busy ? 'Working…' : verb.label}
    </Button>
  );
}

/** One drift finding: what differs, the fix it names, and the verbs that run it. */
export function DriftFindingRow({ finding, resolution, controls }: {
  finding: StackDriftFinding;
  resolution: DriftResolution;
  controls: DriftRowControls;
}) {
  const gitPath = finding.kind === 'managed-path-conflict';
  const { primary, secondary } = resolution;
  const dismissable = isDismissableDriftFinding(finding) && finding.dismissPolicy !== undefined;

  const verbs = (
    <>
      {primary && <VerbButton verb={primary} busy={controls.isBusy(finding, primary)} onClick={() => controls.run(finding, primary)} />}
      {secondary.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 max-md:min-h-11 max-md:min-w-11"
              aria-label={`More actions: ${finding.service || DRIFT_FINDING_LABEL[finding.kind]}`}
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {secondary.map(verb => (
              <DropdownMenuItem key={verb.kind} disabled={controls.isBusy(finding, verb)} onSelect={() => controls.run(finding, verb)}>
                {verb.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  return (
    <div className="border-t border-muted py-2 first:border-t-0" data-testid="drift-finding" data-kind={finding.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!gitPath && (
            <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{finding.service}</span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{DRIFT_FINDING_LABEL[finding.kind]}</span>
        </div>
        {dismissable ? (
          <FindingRowActions
            dismissPolicy={finding.dismissPolicy ?? 'none'}
            canDismiss={controls.canDismiss}
            pending={controls.isDismissing(finding)}
            subject={`${finding.service || DRIFT_FINDING_LABEL[finding.kind]} ${DRIFT_FINDING_LABEL[finding.kind]}`}
            onDismiss={(mode, days) => controls.onDismiss(finding, mode, days)}
          >
            {verbs}
          </FindingRowActions>
        ) : (
          <div className="flex items-center gap-1">{verbs}</div>
        )}
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{finding.detail}</div>
      {finding.expected !== undefined && finding.actual !== undefined && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span className="text-stat-subtitle">compose</span>
          <span className="text-foreground/90">{finding.expected}</span>
          <span className="text-stat-subtitle">→ running</span>
          <span className="font-semibold text-foreground">{finding.actual}</span>
        </div>
      )}
      <div className="mt-1 text-[11px] leading-relaxed text-stat-subtitle" data-testid="drift-remediation">{resolution.remediation}</div>
    </div>
  );
}
