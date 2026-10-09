import { createHash } from 'crypto';
import type { DismissPolicy } from './readiness/types';
import type {
  PostureReasonKind,
  PostureReasonSeverity,
  PostureTarget,
} from './securityPosture';

/**
 * A posture reason's identity on one node: `kind:variant`. `public_exposure` is
 * the only kind that appears at two severities, so it is the only one with two
 * variants; every other kind has a single `all` variant.
 */
export type PostureReasonKey =
  | `${Exclude<PostureReasonKind, 'public_exposure'>}:all`
  | 'public_exposure:conflict'
  | 'public_exposure:unclassified';

export function postureReasonKey(kind: PostureReasonKind, severity: PostureReasonSeverity): PostureReasonKey {
  if (kind === 'public_exposure') return severity === 'blocker' ? 'public_exposure:conflict' : 'public_exposure:unclassified';
  return `${kind}:all`;
}

/**
 * What a team may do with each reason. One exhaustive record, so a new reason
 * fails the build until someone decides how it may be dismissed.
 * `none`: a blocker; it keeps the masthead red and resolves through its own verb or engine.
 * `timed`: the evidence is incomplete or old, so only a dismissal for a set time.
 */
const REASON_DISMISS_POLICY: Record<PostureReasonKey, DismissPolicy> = {
  'fixable_cve:all': 'none',
  'known_exploited:all': 'none',
  'elevated_exploit_risk:all': 'none',
  'secret:all': 'none',
  'dangerous_compose:all': 'none',
  'public_exposure:conflict': 'none',
  'public_exposure:unclassified': 'any',
  'needs_review:all': 'any',
  'waiting_upstream:all': 'any',
  'update_check_uncertain:all': 'timed',
  'stale_scan:all': 'timed',
  'failed_scan:all': 'any',
};

export const POSTURE_REASON_KEYS = Object.keys(REASON_DISMISS_POLICY) as PostureReasonKey[];

export function isPostureReasonKey(value: string): value is PostureReasonKey {
  return Object.prototype.hasOwnProperty.call(REASON_DISMISS_POLICY, value);
}

export function postureDismissPolicy(key: PostureReasonKey): DismissPolicy {
  return REASON_DISMISS_POLICY[key];
}

/** The severity a reason key carries, in the Security vocabulary. */
export function postureKeySeverity(key: PostureReasonKey): PostureReasonSeverity {
  switch (key) {
    case 'stale_scan:all':
    case 'failed_scan:all':
      return 'info';
    case 'needs_review:all':
    case 'waiting_upstream:all':
    case 'update_check_uncertain:all':
    case 'public_exposure:unclassified':
      return 'review';
    default:
      return 'blocker';
  }
}

/** Most severe first. The client uses the same order to decide whether a reason got worse. */
export const POSTURE_SEVERITY_ORDER: readonly PostureReasonSeverity[] = ['blocker', 'review', 'info'];

export function isPostureSeverity(value: unknown): value is PostureReasonSeverity {
  return typeof value === 'string' && (POSTURE_SEVERITY_ORDER as readonly string[]).includes(value);
}

function cleanPart(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (value ?? '').replace(/[\u0000-\u001f]/g, '_');
}

function targetToken(target: PostureTarget): string {
  return [
    cleanPart(target.imageRef),
    cleanPart(target.stackName),
    cleanPart(target.serviceName),
    target.intentStatus ?? '',
    target.intentConflict === true ? 'conflict' : '',
  ].join('\u001f');
}

export interface PostureFingerprintInput {
  severity: PostureReasonSeverity;
  targets?: readonly PostureTarget[];
  targetsTruncated?: boolean;
}

/**
 * Fingerprint of a reason: its severity and its sorted structured targets, plus
 * whether the target list was capped. Drivers are left out on purpose: they are
 * capped in scan order, so hashing them would resurface a dismissal whenever the
 * cap shuffled which findings made the list. Message text and the count are
 * never inputs, so copy edits do not resurface dismissals; the count is tracked
 * beside it so a reason that grows resurfaces.
 */
export function postureFingerprint(input: PostureFingerprintInput): string {
  const targets = (input.targets ?? []).map(targetToken).sort();
  const payload = [
    input.severity,
    `targets:${input.targetsTruncated === true ? 'capped' : 'full'}`,
    ...targets,
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * The dismissal store's key for a reason on one node: `security:<nodeId>:<kind>:<variant>`.
 * The overview is per node, so the node is part of what a dismissal names.
 */
export function securityDismissalKey(nodeId: number, key: PostureReasonKey): string {
  return `security:${nodeId}:${key}`;
}

const MAX_KEY_LENGTH = 96;

export interface ParsedSecurityKey {
  nodeId: number;
  reasonKey: PostureReasonKey;
}

/** Reads a store key back into scope. Null for anything that is not a well-formed security key. */
export function parseSecurityKey(key: string): ParsedSecurityKey | null {
  if (key.length > MAX_KEY_LENGTH) return null;
  const match = /^security:([1-9]\d{0,9}):([a-z_]+:[a-z]+)$/.exec(key);
  if (match === null || !isPostureReasonKey(match[2])) return null;
  return { nodeId: Number(match[1]), reasonKey: match[2] };
}
