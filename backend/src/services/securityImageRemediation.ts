/**
 * Join Security package-fix findings to persisted image-update evidence.
 *
 * Trivy `fixed_version` proves a patched package exists. It does not prove an
 * applicable container image update exists. This module consumes the canonical
 * ImageUpdateService rows only (no registry I/O) and classifies each finding
 * image as: confirmed update available, authoritative waiting-for-upstream, or
 * uncertain remediation availability.
 */

import { normalizeImageRef } from './DriftDetectionService';
import type { StackServiceStatus, StackUpdateDetail } from './DatabaseService';

export type ImageRemediationClass = 'update_available' | 'waiting_upstream' | 'uncertain';

export interface RemediationFindingInput {
  image_ref: string;
  /** Count of unsuppressed Crit/High findings with fixed_version on this image. */
  count: number;
}

export interface ImageRemediationFacts {
  fixableWithImageUpdate: number;
  fixableWaitingUpstream: number;
  fixableUpdateUnknown: number;
  /** True when checks are disabled and any fixable package findings exist. */
  updateChecksDisabled: boolean;
}

export interface ClassifyImageRemediationInput {
  findings: RemediationFindingInput[];
  details: Record<string, StackUpdateDetail>;
  checksEnabled: boolean;
  freshnessWindowMs: number;
  now: number;
}

interface IndexedService {
  stackName: string;
  service: StackServiceStatus;
  checkedAt: number;
}

function collectServiceRefs(service: StackServiceStatus): string[] {
  const refs: string[] = [];
  if (service.image) refs.push(service.image);
  for (const runtime of service.runtimeImages ?? []) {
    if (runtime) refs.push(runtime);
  }
  return refs;
}

/** Build normalizeImageRef → services index from persisted stack update detail. */
export function buildUpdateServiceIndex(
  details: Record<string, StackUpdateDetail>,
): Map<string, IndexedService[]> {
  const index = new Map<string, IndexedService[]>();
  for (const [stackName, detail] of Object.entries(details)) {
    for (const service of detail.services ?? []) {
      for (const ref of collectServiceRefs(service)) {
        const key = normalizeImageRef(ref);
        if (!key) continue;
        const entry: IndexedService = { stackName, service, checkedAt: detail.checkedAt };
        const list = index.get(key);
        if (list) list.push(entry);
        else index.set(key, [entry]);
      }
    }
  }
  return index;
}

function isStackFresh(checkedAt: number, now: number, freshnessWindowMs: number): boolean {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  return now - checkedAt <= freshnessWindowMs;
}

function classifyMatches(
  matches: IndexedService[],
  freshnessWindowMs: number,
  now: number,
): ImageRemediationClass {
  if (matches.length === 0) return 'uncertain';

  let sawCheckable = false;
  let anyConfirmedUpdate = false;
  let anyUncertain = false;
  let anyAuthoritativeNegative = false;

  for (const { service, checkedAt } of matches) {
    if (service.checkStatus === 'not_checkable') continue;
    sawCheckable = true;
    if (service.checkStatus !== 'ok' || !isStackFresh(checkedAt, now, freshnessWindowMs)) {
      anyUncertain = true;
      continue;
    }
    if (service.hasUpdate) anyConfirmedUpdate = true;
    else anyAuthoritativeNegative = true;
  }

  // Confirmed update on any stack wins over sibling partial/stale uncertainty.
  if (anyConfirmedUpdate) return 'update_available';
  if (anyUncertain || !sawCheckable) return 'uncertain';
  if (anyAuthoritativeNegative) return 'waiting_upstream';
  return 'uncertain';
}

function emptyRemediationFacts(
  overrides: Partial<ImageRemediationFacts> = {},
): ImageRemediationFacts {
  return {
    fixableWithImageUpdate: 0,
    fixableWaitingUpstream: 0,
    fixableUpdateUnknown: 0,
    updateChecksDisabled: false,
    ...overrides,
  };
}

/**
 * Classify package-fix Crit/High findings against persisted update evidence.
 * Counts are finding counts (not distinct images).
 */
export function classifyImageRemediation(input: ClassifyImageRemediationInput): ImageRemediationFacts {
  const { findings, details, checksEnabled, freshnessWindowMs, now } = input;

  const totalFixable = findings.reduce((sum, f) => sum + f.count, 0);
  if (totalFixable === 0) return emptyRemediationFacts();
  if (!checksEnabled) {
    return emptyRemediationFacts({
      fixableUpdateUnknown: totalFixable,
      updateChecksDisabled: true,
    });
  }

  let fixableWithImageUpdate = 0;
  let fixableWaitingUpstream = 0;
  let fixableUpdateUnknown = 0;

  const index = buildUpdateServiceIndex(details);
  for (const finding of findings) {
    const key = normalizeImageRef(finding.image_ref);
    const matches = key ? (index.get(key) ?? []) : [];
    switch (classifyMatches(matches, freshnessWindowMs, now)) {
      case 'update_available':
        fixableWithImageUpdate += finding.count;
        break;
      case 'waiting_upstream':
        fixableWaitingUpstream += finding.count;
        break;
      default:
        fixableUpdateUnknown += finding.count;
        break;
    }
  }

  return emptyRemediationFacts({
    fixableWithImageUpdate,
    fixableWaitingUpstream,
    fixableUpdateUnknown,
  });
}
