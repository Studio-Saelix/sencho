/**
 * Aggregates Compose Doctor's networking-relevant rules (cached runs ONLY, via
 * ComposeDoctorService.getLatest, never a fresh node-wide runPreflight/render)
 * into the unified Networking findings list. Doctor findings are either
 * structurally merged into a matching live finding (dedupe key match) or
 * surfaced as a standalone Doctor-only card. Cached data is never presented as
 * fresher than it is: Doctor-only cards carry their `ranAt` and are revalidated
 * against currently loaded facts where a structural check is cheap; otherwise
 * they are retained as cached rather than silently dropped or fabricated as
 * live.
 */
import { createHash } from 'crypto';
import { ComposeDoctorService } from '../ComposeDoctorService';
import type { PreflightFinding } from '../preflight/types';
import type { DependencySnapshot } from '../DockerController';
import type { StackNetworkFacts } from './types';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import type {
  DoctorFindingMetadata,
  NetworkingFinding,
  NetworkingFindingKind,
  NetworkingFindingSeverity,
  NetworkingRecommendedAction,
} from './networkingTypes';

/** The 11 Compose Doctor rules with a networking-relevant interpretation. */
export const DOCTOR_NETWORKING_RULE_KIND: Record<string, NetworkingFindingKind> = {
  'port-conflict-node': 'port-conflict-node',
  'port-conflict-internal': 'port-conflict-internal',
  'external-network-missing': 'external-network-missing',
  'port-exposed-all-interfaces': 'exposure-all-interfaces',
  'network-mode-host': 'network-mode-host',
  'exposure-internal-published': 'exposure-intent-mismatch',
  'sensitive-service-broad-exposure': 'sensitive-service-broad-exposure',
  'exposure-unclassified': 'exposure-unclassified',
  'exposure-port-vs-dossier': 'exposure-port-vs-dossier',
  'reverse-proxy-undocumented': 'reverse-proxy-undocumented',
  'new-network': 'new-network',
};

export const DOCTOR_NETWORKING_RULE_IDS = Object.keys(DOCTOR_NETWORKING_RULE_KIND);

const DOCTOR_SEVERITY_MAP: Record<string, NetworkingFindingSeverity> = {
  blocker: 'critical',
  high: 'high',
  warning: 'medium',
  info: 'info',
};

// Kinds the live engine can also produce; a dedupe-key match merges the Doctor
// occurrence into the live card instead of creating a Doctor-only duplicate.
const LIVE_OVERLAP_KINDS = new Set<NetworkingFindingKind>([
  'external-network-missing',
  'network-mode-host',
  'exposure-all-interfaces',
  'exposure-intent-mismatch',
  'exposure-unclassified',
  'network-missing', // new-network reconciles into this when the stack is running
]);

function resolveNetworkName(sourcePath: string | undefined, facts: StackNetworkFacts | undefined): string | undefined {
  if (!sourcePath || !facts) return undefined;
  const key = sourcePath.replace(/^networks\./, '');
  return facts.networks.find((n) => n.key === key)?.name ?? key;
}

/** Structural dedupe key (never derived from title/message). Returns null when
 *  the finding has no live counterpart to merge into (a Doctor-only kind, or an
 *  interpretable kind missing the structural fields needed to key it). */
function liveDedupeKey(
  kind: NetworkingFindingKind,
  stack: string,
  f: PreflightFinding,
  facts: StackNetworkFacts | undefined,
): { key: string; mergeKind: NetworkingFindingKind } | null {
  switch (kind) {
    case 'external-network-missing': {
      const network = resolveNetworkName(f.sourcePath, facts);
      return network ? { key: `${kind}\0${stack}\0${network}`, mergeKind: kind } : null;
    }
    case 'network-mode-host':
    case 'exposure-all-interfaces':
    case 'exposure-intent-mismatch':
    case 'exposure-unclassified':
      return f.service ? { key: `${kind}\0${stack}\0${f.service}`, mergeKind: kind } : null;
    case 'new-network': {
      const network = resolveNetworkName(f.sourcePath, facts);
      // Reconciles against the live "declared network missing at runtime" finding.
      return network ? { key: `network-missing\0${stack}\0${network}`, mergeKind: 'network-missing' } : null;
    }
    default:
      return null;
  }
}

function toMetadata(ruleId: string, ranAt: number | null, f: PreflightFinding): DoctorFindingMetadata {
  return {
    ruleId,
    ranAt: ranAt ? new Date(ranAt).toISOString() : new Date(0).toISOString(),
    title: f.title,
    message: f.message,
    service: f.service,
    sourcePath: f.sourcePath,
    remediation: f.remediation,
    severity: DOCTOR_SEVERITY_MAP[f.severity] ?? 'info',
  };
}

/** Rule-specific recommended actions for a Doctor-only finding card (H6). */
function doctorOnlyActions(kind: NetworkingFindingKind, stack: string): NetworkingRecommendedAction[] {
  const doctorAction: NetworkingRecommendedAction = { kind: 'open-stack-doctor', label: 'Open Doctor', stack };
  switch (kind) {
    case 'port-conflict-node':
    case 'port-conflict-internal':
      return [doctorAction, { kind: 'open-stack-editor', label: 'Open stack editor', stack }];
    case 'sensitive-service-broad-exposure':
      return [doctorAction, { kind: 'open-stack-networking', label: 'Open stack networking', stack }];
    case 'exposure-port-vs-dossier':
    case 'reverse-proxy-undocumented':
      return [doctorAction, { kind: 'open-stack-dossier', label: 'Open Dossier', stack }];
    case 'new-network':
      return [doctorAction, { kind: 'open-stack-networking', label: 'Open stack networking', stack }];
    default:
      return [doctorAction, { kind: 'open-stack-networking', label: 'Open stack networking', stack }];
  }
}

/** Revalidates a Doctor occurrence against already-loaded facts, never an extra
 *  render/snapshot call. Returns false when current data conclusively proves
 *  the finding resolved (it should be discarded), true when it should be kept
 *  (either confirmed current, or simply not cheaply checkable so kept cached). */
function isStillPlausible(
  kind: NetworkingFindingKind,
  f: PreflightFinding,
  facts: StackNetworkFacts | undefined,
  snapshot: DependencySnapshot | null,
): boolean {
  if (!facts?.renderable) return true; // can't check; keep cached
  switch (kind) {
    case 'network-mode-host':
    case 'exposure-all-interfaces':
    case 'exposure-intent-mismatch':
    case 'exposure-unclassified':
    case 'sensitive-service-broad-exposure':
    case 'port-conflict-node':
    case 'port-conflict-internal': {
      // These are all service-scoped: if the service no longer exists in the
      // current effective model, the finding is stale.
      if (!f.service) return true;
      return facts.services.some((svc) => svc.name === f.service);
    }
    case 'external-network-missing':
    case 'new-network': {
      const network = resolveNetworkName(f.sourcePath, facts);
      if (!network || !snapshot) return true;
      return !snapshot.networks.some((n) => n.name === network);
    }
    default:
      return true;
  }
}

interface DoctorAggregationOptions {
  nodeId: number;
  stackNames: string[];
  stackFacts: StackNetworkFacts[];
  snapshot: DependencySnapshot | null;
}

/** Merges cached Doctor findings into the live findings list. Returns the full
 *  unified list (live findings enriched in place, plus new Doctor-only cards
 *  appended). Fail-soft per stack: a getLatest() failure is logged and skipped,
 *  never fails the whole aggregate. */
export function applyDoctorNetworkingFindings(
  live: NetworkingFinding[],
  options: DoctorAggregationOptions,
): NetworkingFinding[] {
  const { nodeId, stackNames, stackFacts, snapshot } = options;
  const factsByStack = new Map(stackFacts.map((f) => [f.stack, f]));

  // Index live findings by their own structural key for O(1) merge lookup.
  const liveByKey = new Map<string, NetworkingFinding>();
  for (const f of live) {
    if (!LIVE_OVERLAP_KINDS.has(f.kind)) continue;
    const keyParts = f.service
      ? [f.kind, f.stack ?? '', f.service]
      : f.network
        ? [f.kind, f.stack ?? '', f.network]
        : null;
    if (keyParts) liveByKey.set(keyParts.join('\0'), f);
  }

  // Doctor-only groups: same (mergeKind, stack, service-or-network) collapse
  // into ONE card carrying every matched occurrence (H2 one-to-many); distinct
  // services/networks/stacks always get distinct cards.
  const doctorOnlyGroups = new Map<string, { kind: NetworkingFindingKind; stack: string; service?: string; network?: string; entries: DoctorFindingMetadata[] }>();
  let ordinal = 0;

  for (const stack of stackNames) {
    let report;
    try {
      report = ComposeDoctorService.getInstance().getLatest(nodeId, stack);
    } catch (error) {
      console.warn('[Networking] Doctor lookup failed for stack %s; skipped:',
        sanitizeForLog(stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
      continue;
    }
    if (report.status === 'never-run' || report.findings.length === 0) continue;
    const facts = factsByStack.get(stack);

    for (const f of report.findings) {
      if (f.acknowledged === true) continue;
      const kind = DOCTOR_NETWORKING_RULE_KIND[f.ruleId];
      if (!kind) continue;
      if (!isStillPlausible(kind, f, facts, snapshot)) continue;

      const dedupe = liveDedupeKey(kind, stack, f, facts);
      const metadata = toMetadata(f.ruleId, report.ranAt, f);

      if (dedupe) {
        const liveMatch = liveByKey.get(dedupe.key);
        if (liveMatch) {
          if (!liveMatch.sources.includes('doctor')) liveMatch.sources.push('doctor');
          liveMatch.doctorFindings.push(metadata);
          if (!liveMatch.recommendedActions.some((a) => a.kind === 'open-stack-doctor')) {
            liveMatch.recommendedActions.push({ kind: 'open-stack-doctor', label: 'Open Doctor', stack });
          }
          continue;
        }
        // new-network with no live network-missing counterpart: the network is
        // either present (already filtered by isStillPlausible) or the stack is
        // stopped/not-yet-deployed, so show the Doctor informational read
        // instead of a misleading live drift interpretation. Falls through to
        // the Doctor-only group below, keyed on the reconciled mergeKind so a
        // network-missing counterpart appearing later still collapses.
      }

      const groupKey = dedupe
        ? dedupe.key
        : f.service
          ? `${kind}\0${stack}\0${f.service}`
          : `${kind}\0${stack}\0ordinal-${ordinal++}`;
      const group = doctorOnlyGroups.get(groupKey) ?? { kind, stack, service: f.service, entries: [] };
      group.entries.push(metadata);
      doctorOnlyGroups.set(groupKey, group);
    }
  }

  const doctorOnlyFindings: NetworkingFinding[] = [];
  for (const group of doctorOnlyGroups.values()) {
    const worstSeverity = group.entries.reduce<NetworkingFindingSeverity>((worst, entry) => {
      const rank: Record<NetworkingFindingSeverity, number> = { info: 0, medium: 1, high: 2, critical: 3 };
      return rank[entry.severity] > rank[worst] ? entry.severity : worst;
    }, 'info');
    const idPayload = [group.kind, group.stack, group.service ?? '', group.entries.map((e) => e.ruleId).join(',')].join('\0');
    doctorOnlyFindings.push({
      id: createHash('sha256').update(idPayload).digest('hex').slice(0, 16),
      kind: group.kind,
      severity: worstSeverity,
      title: group.entries[0].title,
      message: group.entries[0].message,
      stack: group.stack,
      service: group.service,
      evidence: [
        { label: 'Stack', value: group.stack },
        ...(group.service ? [{ label: 'Service', value: group.service }] : []),
      ],
      recommendedActions: doctorOnlyActions(group.kind, group.stack),
      sources: ['doctor'],
      doctorFindings: group.entries,
    });
  }

  return [...live, ...doctorOnlyFindings];
}
