import type { DismissPolicy, FindingDismissal } from '@/types/findingDismissal';

// Mirrors the backend drift payload (the frontend never imports backend).
export type StackDriftStatus = 'in-sync' | 'drifted' | 'missing-runtime' | 'unreachable';

export type DriftFindingKind =
  | 'service-missing' | 'service-undeclared' | 'image-mismatch' | 'ports-mismatch'
  | 'network-undeclared' | 'network-missing' | 'managed-path-conflict';

/** Whether the running image was built after the one compose names; `unknown` unless provable. */
export type DriftImageAge = 'running-newer' | 'running-older' | 'unknown';

export interface StackDriftFinding {
  kind: DriftFindingKind;
  service: string;
  detail: string;
  expected?: string;
  actual?: string;
  imageAge?: DriftImageAge;
  // Optional so a report from an older remote node still renders. Without them
  // there is nothing to dismiss, so the row carries no Dismiss.
  id?: string;
  fingerprint?: string;
  severity?: string;
  count?: number;
  dismissPolicy?: DismissPolicy;
}

/** A finding the server published with the facts a dismissal is compared against. */
export type DismissableDriftFinding = StackDriftFinding & {
  id: string;
  fingerprint: string;
  severity: string;
  count: number;
};

export function isDismissableDriftFinding(finding: StackDriftFinding): finding is DismissableDriftFinding {
  return finding.id !== undefined && finding.fingerprint !== undefined
    && finding.severity !== undefined && finding.count !== undefined;
}

export interface DriftTemporal {
  hasBaseline: boolean;
  sourceChanged: boolean;
  renderedChanged: boolean;
}

export interface DriftLedgerEntry {
  service: string;
  kind: DriftFindingKind;
  message: string;
  detectedAt: number;
  resolvedAt: number | null;
}

export type DriftDismissal = FindingDismissal;
