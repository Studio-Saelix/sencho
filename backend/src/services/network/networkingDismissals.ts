import { createHash } from 'crypto';
import type { DismissPolicy } from '../readiness/types';
import {
  NETWORKING_FINDING_KINDS,
  type NetworkingFinding,
  type NetworkingFindingKind,
  type NetworkingFindingSeverity,
} from './networkingTypes';

/** The five parts of a finding's structural key, in order. Empty means the part does not apply. */
export interface NetworkingKeyParts {
  kind: NetworkingFindingKind;
  stack: string;
  service: string;
  network: string;
  subject: string;
}

const PART_SEPARATOR = '|';

/** `|` and control characters cannot appear in a part, so the key splits unambiguously. */
function cleanPart(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[|\u0000-\u001f]/g, '_');
}

/**
 * The finding's id: `kind|stack|service|network|subject`. Built from the facts
 * that name the finding's target, never its message, so rewording a message or
 * adding another finding does not move it. `subject` separates findings that
 * share the other four (a duplicated DNS name, a container).
 */
export function networkingFindingKey(parts: NetworkingKeyParts): string {
  return [parts.kind, cleanPart(parts.stack), cleanPart(parts.service), cleanPart(parts.network), cleanPart(parts.subject)].join(PART_SEPARATOR);
}

/**
 * Fingerprint of a finding: its severity and its sorted structured targets.
 * Message text is never an input, so copy edits do not resurface dismissals.
 */
export function networkingFingerprint(severity: NetworkingFindingSeverity, targets: readonly string[]): string {
  const payload = [severity, ...[...targets].sort()].join('\0');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * The dismissal store's key for a finding on one node: `networking:<nodeId>:<id>`.
 * The aggregate is per node, so the node is part of what a dismissal names.
 */
export function networkingDismissalKey(nodeId: number, findingId: string): string {
  return `networking:${nodeId}:${findingId}`;
}

export interface ParsedNetworkingKey extends NetworkingKeyParts {
  nodeId: number;
}

/** Reads a store key back into scope. Null for anything that is not a well-formed networking key. */
export function parseNetworkingKey(key: string): ParsedNetworkingKey | null {
  const match = /^networking:([1-9]\d{0,9}):(.+)$/.exec(key);
  if (match === null) return null;
  const parts = match[2].split(PART_SEPARATOR);
  if (parts.length !== 5) return null;
  const [kind, stack, service, network, subject] = parts;
  if (!(NETWORKING_FINDING_KINDS as readonly string[]).includes(kind)) return null;
  return { nodeId: Number(match[1]), kind: kind as NetworkingFindingKind, stack, service, network, subject };
}

/**
 * What a team may do with a finding of each kind. One exhaustive record, so a
 * new kind fails the build until someone decides how it may be dismissed.
 * `timed`: the evidence could not be read, so only a dismissal for a set time.
 * `none`: Compose Doctor owns it; it is acknowledged there, which changes
 * update readiness, so it is never a silent dismissal.
 */
const KIND_DISMISS_POLICY: Record<NetworkingFindingKind, DismissPolicy> = {
  'external-network-missing': 'any',
  'network-missing': 'any',
  'network-undeclared': 'any',
  'declared-network-unused': 'any',
  'foreign-network-attachment': 'any',
  'alias-collision': 'any',
  'network-mode-host': 'any',
  'exposure-unclassified': 'any',
  'exposure-all-interfaces': 'any',
  'shared-network': 'any',
  'network-name-collision': 'any',
  'service-name-collision': 'any',
  'large-flat-network': 'any',
  'advanced-driver-caveat': 'any',
  'runtime-unavailable': 'timed',
  'exposure-intent-mismatch': 'any',
  'port-conflict-node': 'none',
  'port-conflict-internal': 'none',
  'sensitive-service-broad-exposure': 'none',
  'exposure-port-vs-dossier': 'none',
  'reverse-proxy-undocumented': 'none',
  'new-network': 'none',
};

export function networkingDismissPolicy(kind: NetworkingFindingKind): DismissPolicy {
  return KIND_DISMISS_POLICY[kind];
}

/** Most severe first. The client uses the same order to decide whether a finding got worse. */
export const NETWORKING_SEVERITY_ORDER: readonly NetworkingFindingSeverity[] = ['critical', 'high', 'medium', 'info'];

export function isNetworkingSeverity(value: unknown): value is NetworkingFindingSeverity {
  return typeof value === 'string' && (NETWORKING_SEVERITY_ORDER as readonly string[]).includes(value);
}

/** Fields every finding carries, derived once from its key parts and targets. */
export function dismissFields(
  parts: NetworkingKeyParts,
  severity: NetworkingFindingSeverity,
  targets: readonly string[],
): Pick<NetworkingFinding, 'id' | 'fingerprint' | 'count' | 'dismissPolicy'> {
  return {
    id: networkingFindingKey(parts),
    fingerprint: networkingFingerprint(severity, targets),
    count: Math.max(1, targets.length),
    dismissPolicy: networkingDismissPolicy(parts.kind),
  };
}
