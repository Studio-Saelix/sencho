/**
 * Display copy for detected exposure: the strongest conflict chip for a declared
 * intent, and the proof line that names why a detection is incomplete. The
 * detection (paths, conflicts, reasons) comes from the backend, so the panel and
 * the findings name the same thing; exposureAnswer only summarizes it for the
 * Networking tab. Nothing here claims reachability, verified routing or safety; the
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
  'runtime-ports-extra': 'a running container publishes a port the Compose file does not',
  'runtime-ports-missing': 'the Compose file declares a port the running container does not publish',
};

/** The order the reasons read in, so the sentence does not depend on the order
 *  the node happens to push them in. */
const REASON_ORDER: readonly UndeterminedReason[] = [
  'foreign-namespace', 'hidden-connector', 'runtime-attachment', 'runtime-ports-missing', 'runtime-ports-extra',
];

/** Reason names a node on another build may still send after this set changed. */
const LEGACY_REASON_TEXT: Record<string, string> = {
  'runtime-ports-differ': 'the running container and the Compose file disagree about the published ports',
};

/** The reason set travels with the node, so a node from another build may send a
 *  name this build does not know. Say what is certain rather than dropping the
 *  sentence. */
function reasonText(reason: UndeterminedReason): string {
  return (REASON_TEXT as Record<string, string | undefined>)[reason]
    ?? LEGACY_REASON_TEXT[reason]
    ?? 'the node reported a reason this version of Sencho does not recognize';
}

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
export function proofLine(detected: DetectedServiceExposure, options: { includeRuntimeNote?: boolean } = {}): string | null {
  const parts: string[] = [];
  const reasons: UndeterminedReason[] = detected.status === 'undetermined'
    ? detected.reasons
    : detected.status === 'paths'
      ? detected.incomplete
      : [];
  if (reasons.length > 0) {
    const prefix = detected.status === 'undetermined' ? 'could not be determined' : 'partly undetermined';
    const rank = (reason: UndeterminedReason) => {
      const index = REASON_ORDER.indexOf(reason);
      return index < 0 ? REASON_ORDER.length : index;
    };
    const ordered = [...reasons].sort((a, b) => rank(a) - rank(b));
    parts.push(`${prefix}: ${ordered.map(reasonText).join('; ')}`);
  }
  const vias = [...new Set(detected.paths
    .map(path => (path.kind === 'host-port' || path.kind === 'host-network') ? path.via : undefined)
    .filter((via): via is string => via !== undefined))];
  for (const via of vias) parts.push(`the host path comes from "${via}", whose network namespace it shares`);
  if (detected.externalNetworks.length > 0) {
    parts.push(`a connector in another stack on ${quotedList(detected.externalNetworks)} could reach it`);
  }
  if (!detected.runtimeChecked && (options.includeRuntimeNote ?? true)) parts.push('runtime not checked, so a running container may reach more than the file says');
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}

export interface ExposureAnswerInput {
  detected?: DetectedServiceExposure;
  /** The service's own intent, else the stack's; null when neither is set. */
  effectiveIntent: ExposureIntent | null;
}

export interface ExposureAnswer {
  tone: 'warning' | 'neutral' | 'success';
  title: string;
  line: string;
}

/** True when some service's runtime was not read, so its exposure is drawn from the file alone. */
export function runtimeUnchecked(services: readonly Pick<ExposureAnswerInput, 'detected'>[]): boolean {
  return services.some(service => service.detected && !service.detected.runtimeChecked);
}

/** Detection that could not be fully established: undetermined, partly undetermined, a connector
 *  in another stack that could reach it (the service's proof line says so), or not reported at all. */
function isPartlyDetermined(detected: DetectedServiceExposure | undefined): boolean {
  return !detected
    || detected.status === 'undetermined'
    || (detected.status === 'paths' && detected.incomplete.length > 0)
    || detected.externalNetworks.length > 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one answer for a stack's exposure, built only from the detection the node
 * sends: how many services conflict with their declared intent (each service's
 * chip says why), else how many could not be fully determined, else whether
 * intent is set at all. Null when no service has detection (an older node),
 * since there is nothing to answer from. A green answer is given only when
 * every service was fully determined.
 */
export function exposureAnswer(services: readonly ExposureAnswerInput[]): ExposureAnswer | null {
  const detectedServices = services.filter(service => service.detected);
  if (detectedServices.length === 0) return null;
  const flagged: ExposureChip['level'][] = [];
  for (const service of detectedServices) {
    if (!service.detected || !service.effectiveIntent) continue;
    const chip = conflictChip(service.detected, service.effectiveIntent);
    if (chip && chip.level !== 'note') flagged.push(chip.level);
  }
  if (flagged.length > 0) {
    // The specific reason is on each service's own chip; the Answer only counts.
    const hard = flagged.filter(level => level === 'conflict').length;
    const title = hard > 0 ? 'conflict' : 'may conflict';
    let line: string;
    if (hard === flagged.length) line = `${plural(hard, 'service conflicts', 'services conflict')} with the declared exposure intent.`;
    else if (hard === 0) line = `${plural(flagged.length, 'service may conflict', 'services may conflict')} with the declared exposure intent.`;
    else line = `${plural(hard, 'service conflicts', 'services conflict')} and ${flagged.length - hard} may conflict with the declared exposure intent.`;
    return { tone: 'warning', title, line };
  }
  const partial = services.filter(service => isPartlyDetermined(service.detected)).length;
  if (partial > 0) {
    return {
      tone: 'neutral',
      title: 'partly determined',
      line: `${plural(partial, 'service has', 'services have')} exposure that could not be fully determined, so no match is claimed.`,
    };
  }
  // The `unknown` intent says the service is not classified, so it counts as unset.
  const unset = detectedServices.filter(service => !service.effectiveIntent || service.effectiveIntent === 'unknown').length;
  if (unset > 0) {
    return {
      tone: 'neutral',
      title: 'no intent set',
      line: `${plural(unset, 'service has', 'services have')} no exposure intent, so only the detected exposure is shown.`,
    };
  }
  return { tone: 'success', title: 'matches intent', line: 'The declared exposure intent matches what Sencho detected.' };
}
