import { createHash } from 'crypto';
import type { DismissPolicy } from './readiness/types';
import type { DismissalMode } from './findingDismissals/types';
import type { DriftFindingKind } from './DriftDetectionService';
import type { StackDriftFindingRow } from './DatabaseService';

/**
 * Dismissing a stack drift finding. Unlike the hub-held store the other
 * surfaces use, a drift dismissal lives on the finding's own row in the drift
 * ledger (`stack_drift_findings`) on the node that owns the stack, so the
 * ledger's detected-to-resolved lifecycle retires it: once the finding clears,
 * its row is closed, and a recurrence is a new row with no dismissal.
 *
 * Nothing here feeds a verdict. The drift status, its finding count, the
 * Fleet and notification rollups all keep counting dismissed findings.
 */

/** Every kind the ledger can hold: the engine's kinds plus the Git managed-path conflict. */
export type DriftLedgerKind = DriftFindingKind | 'managed-path-conflict';

/**
 * What a team may do with each kind. One exhaustive record, so a new kind
 * fails the build until someone decides how it may be dismissed.
 * `none`: the managed-path conflict carries no structured evidence to compare
 * (only a message), and a secret-bearing path must not be quietly hideable.
 */
const DRIFT_DISMISS_POLICY: Record<DriftLedgerKind, DismissPolicy> = {
  'service-missing': 'any',
  'service-undeclared': 'any',
  'image-mismatch': 'any',
  'ports-mismatch': 'any',
  'network-undeclared': 'any',
  'network-missing': 'any',
  'managed-path-conflict': 'none',
};

export function driftDismissPolicy(kind: DriftLedgerKind): DismissPolicy {
  return DRIFT_DISMISS_POLICY[kind];
}

export function isDriftLedgerKind(value: string): value is DriftLedgerKind {
  return Object.prototype.hasOwnProperty.call(DRIFT_DISMISS_POLICY, value);
}

/** The ledger stores every finding at one severity, so a drift finding can never "get more severe". */
export const DRIFT_FINDING_SEVERITY = 'warning';

/** The facts the client compares a dismissal against, published beside each live finding. */
export interface DriftFindingFacts {
  /** Stable identity on a stack: `drift:<kind>:<service>`. */
  id: string;
  fingerprint: string;
  severity: typeof DRIFT_FINDING_SEVERITY;
  count: number;
  dismissPolicy: DismissPolicy;
}

export function driftFindingId(kind: DriftLedgerKind, service: string): string {
  return `drift:${kind}:${service}`;
}

const MAX_SERVICE_LENGTH = 256;

export interface ParsedDriftKey {
  kind: DriftLedgerKind;
  service: string;
}

/** Reads a finding id back into the ledger identity. Null for anything that is not a well-formed drift id. */
export function parseDriftKey(id: string): ParsedDriftKey | null {
  const match = /^drift:([a-z-]+):(.*)$/s.exec(id);
  if (match === null || !isDriftLedgerKind(match[1])) return null;
  const service = match[2];
  // eslint-disable-next-line no-control-regex
  if (service.length > MAX_SERVICE_LENGTH || /[\u0000-\u001f]/.test(service)) return null;
  return { kind: match[1], service };
}

interface FactsInput {
  kind: DriftLedgerKind;
  service: string;
  expected?: string;
  actual?: string;
}

function countNames(list: string | undefined): number {
  if (list === undefined || list === '') return 1;
  return Math.max(1, list.split(', ').length);
}

/**
 * Fingerprint of a finding: its kind, service, and the structured values it
 * compares. The message is never an input, so rewording a finding does not
 * resurface a dismissal. The image age the engine derives is left out too: it
 * says what to do about a finding, not what the finding is.
 */
export function driftFindingFacts(finding: FactsInput): DriftFindingFacts {
  const payload = [finding.kind, finding.service, finding.expected ?? '', finding.actual ?? ''].join('\0');
  // The network kinds list every network they name, so the count tracks how many
  // there are and a finding that grows lifts a dismissal whatever its mode.
  let count = 1;
  if (finding.kind === 'network-undeclared') count = countNames(finding.actual);
  if (finding.kind === 'network-missing') count = countNames(finding.expected);
  return {
    id: driftFindingId(finding.kind, finding.service),
    fingerprint: createHash('sha256').update(payload).digest('hex').slice(0, 16),
    severity: DRIFT_FINDING_SEVERITY,
    count,
    dismissPolicy: driftDismissPolicy(finding.kind),
  };
}

/** The ledger columns a dismissal writes. */
export interface DriftDismissalColumns {
  dismissed_by: string;
  dismissed_at: number;
  dismissed_fingerprint: string;
  dismissed_mode: DismissalMode;
  dismissed_expires_at: number | null;
  dismissed_count: number;
}

/** The wire shape the frontend partitions against; the same fields as a hub dismissal. */
export interface DriftDismissal {
  id: number;
  nodeId: number;
  surface: 'drift';
  findingKey: string;
  fingerprint: string;
  severity: string;
  count: number;
  mode: DismissalMode;
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
}

function isDismissalMode(value: unknown): value is DismissalMode {
  return value === 'until_change' || value === 'days' || value === 'forever';
}

/** The dismissal a ledger row carries, or null when it has none (or one this build cannot read). */
export function toDriftDismissal(row: StackDriftFindingRow): DriftDismissal | null {
  if (
    row.dismissed_by == null || row.dismissed_at == null || row.dismissed_fingerprint == null
    || !isDismissalMode(row.dismissed_mode) || row.dismissed_count == null
    || !isDriftLedgerKind(row.finding_type)
  ) {
    return null;
  }
  return {
    id: row.id,
    nodeId: row.node_id,
    surface: 'drift',
    findingKey: driftFindingId(row.finding_type, row.service),
    fingerprint: row.dismissed_fingerprint,
    severity: DRIFT_FINDING_SEVERITY,
    count: row.dismissed_count,
    mode: row.dismissed_mode,
    expiresAt: row.dismissed_expires_at ?? null,
    createdBy: row.dismissed_by,
    createdAt: row.dismissed_at,
  };
}
