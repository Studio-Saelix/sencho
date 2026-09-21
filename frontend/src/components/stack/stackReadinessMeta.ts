import { Check, CircleHelp, Info, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReadinessVerdict, RollbackOverall } from '@/types/readiness';

/**
 * How the canonical update-guard verdicts are presented.
 *
 * These live beside the two stack surfaces but in their own module, so the
 * dialog, the dossier section, and Fleet Readiness all restate a verdict with
 * one set of words, icons, and tones. A second copy is how the surfaces drift.
 *
 * Every payload word is read through the accessors at the bottom rather than
 * off the tables: a verdict word a newer hub added would otherwise index out to
 * undefined at each call site.
 */

const VERDICT_META: Record<ReadinessVerdict, {
  label: string;
  icon: LucideIcon;
  tone: string;
  line: string;
}> = {
  ready: {
    label: 'ready',
    icon: Check,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'Nothing stands out; the update can proceed.',
  },
  ready_with_warnings: {
    label: 'ready with warnings',
    icon: Info,
    tone: 'border-info/40 bg-info/[0.06] text-info',
    line: 'The update can proceed; review the warnings below first.',
  },
  review_required: {
    label: 'review required',
    icon: TriangleAlert,
    tone: 'border-warning/40 bg-warning/[0.06] text-warning',
    line: 'Something needs a look before this update.',
  },
  blocked: {
    label: 'blocked',
    icon: ShieldAlert,
    tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
    line: 'A blocker was found. Proceeding is likely to fail or be stopped by policy.',
  },
  unknown: {
    label: 'unknown',
    icon: CircleHelp,
    tone: 'border-muted bg-card/40 text-stat-subtitle',
    line: 'Readiness could not be fully verified; proceed with care.',
  },
};

const OVERALL_META: Record<RollbackOverall, { label: string; tone: string }> = {
  ready: { label: 'ready', tone: 'border-success/40 bg-success/[0.06] text-success' },
  partial: { label: 'partial', tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  not_ready: { label: 'not ready', tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive' },
};

/**
 * An update verdict's presentation, falling back to the unverified verdict for
 * a word this build does not know: an unrecognized verdict must not read as a
 * clean one.
 */
export function verdictMeta(verdict: ReadinessVerdict) {
  return VERDICT_META[verdict] ?? VERDICT_META.unknown;
}

/**
 * A rollback overall's presentation, falling back to the warning entry for a
 * word this build does not know: an unreadable overall must not claim a clean
 * check (`ready`) or a failed one (`not_ready`).
 */
export function overallMeta(overall: RollbackOverall) {
  return OVERALL_META[overall] ?? OVERALL_META.partial;
}
