/**
 * Display copy for detected exposure: the strongest conflict chip for a declared
 * intent, and the proof line that names why a detection is incomplete. The
 * answer itself comes from the backend, so the panel and the findings name the
 * same thing. Nothing here claims reachability, verified routing or safety; the
 * tests assert that.
 */
import { tunnelProviderLabel } from '@/lib/tunnelExposure';
import type {
  ConflictReason, DetectedServiceExposure, ExposureIntent, IntentConflict, UndeterminedReason,
} from '@/types/networking';

const LEVEL_RANK: Record<IntentConflict['level'], number> = { conflict: 0, possible: 1, note: 2 };

const FACT_WORD: Record<ConflictReason, string> = {
  'host-port': 'published port',
  'loopback-port': 'published port',
  'host-network': 'host network',
  tunnel: 'tunnel',
  'broad-bind': 'broad bind',
  'shared-namespace': 'shared namespace',
};

const REASON_TEXT: Record<UndeterminedReason, string> = {
  'foreign-namespace': 'it shares a network namespace with a container outside this stack',
  'hidden-connector': 'a tunnel connector runs in another container\'s namespace, so its reach is unknown',
  'runtime-attachment': 'a running container is attached to a network this stack does not declare',
  'runtime-ports-differ': 'a running container publishes ports the Compose file does not',
};

export interface ExposureChip {
  level: IntentConflict['level'];
  text: string;
}

/** The namespace root a `via` path belongs to, when the entry covers one. */
function viaOf(detected: DetectedServiceExposure, index: number): string | undefined {
  const path = detected.paths[index];
  return path && (path.kind === 'host-port' || path.kind === 'host-network') ? path.via : undefined;
}

/** The strongest entry for one declared intent, or null when it is not contradicted. */
export function strongestConflict(detected: DetectedServiceExposure, intent: ExposureIntent): IntentConflict | null {
  const entries = detected.conflicts[intent] ?? [];
  let strongest: IntentConflict | null = null;
  for (const entry of entries) {
    if (!strongest || LEVEL_RANK[entry.level] < LEVEL_RANK[strongest.level]) strongest = entry;
  }
  return strongest;
}

/** The single chip for a declared intent: what the facts say about it, in one line. */
export function conflictChipText(detected: DetectedServiceExposure, conflict: IntentConflict, intent: ExposureIntent): string {
  if (conflict.level === 'conflict') return `conflicts with ${intent}: ${FACT_WORD[conflict.reason]}`;
  if (conflict.level === 'possible') return `may conflict with ${intent}: ${FACT_WORD[conflict.reason]}`;
  switch (conflict.reason) {
    case 'broad-bind':
      return `broad bind alongside ${intent}`;
    case 'shared-namespace': {
      const via = viaOf(detected, conflict.paths[0]);
      return via ? `shared namespace with ${via}` : `shared namespace alongside ${intent}`;
    }
    case 'host-network': {
      const via = viaOf(detected, conflict.paths[0]);
      return via ? `host network through ${via}` : `host network alongside ${intent}`;
    }
    case 'tunnel': {
      const path = detected.paths[conflict.paths[0]];
      return path?.kind === 'connector'
        ? `${tunnelProviderLabel(path.provider)} node alongside ${intent}`
        : `private overlay alongside ${intent}`;
    }
    default:
      return `note alongside ${intent}`;
  }
}

export function conflictChip(detected: DetectedServiceExposure, intent: ExposureIntent): ExposureChip | null {
  const conflict = strongestConflict(detected, intent);
  return conflict ? { level: conflict.level, text: conflictChipText(detected, conflict, intent) } : null;
}

function quotedList(names: string[]): string {
  const quoted = names.map(name => `"${name}"`);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The proof line for a service card: why the detected reach could not be fully
 * established, which namespace a host path comes from, the external-network
 * caveat, and whether the runtime was read at all. Null when none applies.
 */
export function proofLine(detected: DetectedServiceExposure): string | null {
  const parts: string[] = [];
  const reasons: UndeterminedReason[] = detected.status === 'undetermined'
    ? detected.reasons
    : detected.status === 'paths'
      ? detected.incomplete
      : [];
  if (reasons.length > 0) {
    const prefix = detected.status === 'undetermined' ? 'could not be determined' : 'partly undetermined';
    parts.push(`${prefix}: ${reasons.map(reason => REASON_TEXT[reason]).join('; ')}`);
  }
  const vias = [...new Set(detected.paths
    .map(path => (path.kind === 'host-port' || path.kind === 'host-network') ? path.via : undefined)
    .filter((via): via is string => via !== undefined))];
  for (const via of vias) parts.push(`the host path comes from "${via}", whose network namespace it shares`);
  if (detected.externalNetworks.length > 0) {
    parts.push(`a connector in another stack on ${quotedList(detected.externalNetworks)} could reach it`);
  }
  if (!detected.runtimeChecked) parts.push('runtime not checked, so a running container may reach more than the file says');
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}
