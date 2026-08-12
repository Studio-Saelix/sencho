/**
 * Classifies network-exposed Crit/High images into posture buckets.
 *
 * Exposure fact (Compose beyond loopback) is separate from exposure correctness
 * (intent match) and from Security consequence (KEV, elevated EPSS, confirmed
 * image update). Intentional exposure never independently manufactures an
 * Action-needed exposure blocker. Package fixed_version alone never recreates
 * that blocker through this path.
 */
import { HIGH_EPSS_THRESHOLD, type PostureDriverFinding, type PostureTarget } from './securityPosture';

/** Bounded driver findings attached to vulnerability-derived posture reasons. */
export const POSTURE_DRIVER_CAP = 50;

export interface CappedDrivers {
  drivers: PostureDriverFinding[];
  /** Full contributing count before the display cap. */
  driverCount: number;
  driversTruncated: boolean;
}

export function capDriverFindings(drivers: PostureDriverFinding[]): CappedDrivers {
  return {
    drivers: drivers.slice(0, POSTURE_DRIVER_CAP),
    driverCount: drivers.length,
    driversTruncated: drivers.length > POSTURE_DRIVER_CAP,
  };
}

export type CveIntelLookup = Map<string, { kev?: boolean; epssScore?: number | null }>;

export interface ExposedFindingRow {
  vulnerability_id: string;
  /** Present when the finding survived suppression filtering as actionable. */
  suppressed?: boolean;
}

export interface ClassifyExposedImagesInput {
  /** Crit/High findings keyed by image_ref (raw, before suppression). */
  critHighByImage: Map<string, ExposedFindingRow[]>;
  /** image_ref → true when Compose declares beyond-loopback / host-network. */
  exposedMap: Map<string, boolean>;
  /** Per-image exposure targets already enriched with Networking intent. */
  targetsByImage: Map<string, PostureTarget[]>;
  /** Unsuppressed findings per image (caller applies applySuppressions). */
  unsuppressedByImage: Map<string, ExposedFindingRow[]>;
  intel: CveIntelLookup;
}

export interface ClassifyExposedImagesResult {
  /** Distinct exposed images in the Crit/High index (incl. fully suppressed). */
  publiclyExposed: number;
  /** Intent mismatch (internal/same-node while exposed) with unsuppressed Crit/High. */
  exposureIntentConflict: number;
  exposureIntentConflictTargets: PostureTarget[];
  /** Intent unset/unavailable (not intentional) with unsuppressed Crit/High. Review only. */
  exposedUnclassified: number;
  exposedUnclassifiedTargets: PostureTarget[];
  /**
   * Network-exposed images with unsuppressed elevated-EPSS Crit/High.
   * Independent of intentional vs unclassified; never uses fixed_version alone.
   */
  elevatedExploitRisk: number;
  elevatedExploitRiskTargets: PostureTarget[];
  elevatedExploitRiskDrivers: PostureDriverFinding[];
  elevatedExploitRiskDriverCount: number;
  elevatedExploitRiskDriversTruncated: boolean;
}

function isIntentionalTarget(t: PostureTarget): boolean {
  return (
    t.intentStatus === 'set'
    && !t.intentConflict
    && (t.exposureIntent === 'public'
      || t.exposureIntent === 'lan'
      || t.exposureIntent === 'reverse-proxy'
      || t.exposureIntent === 'temporary')
  );
}

/**
 * Bucket an image's exposure contexts.
 * Conflict wins. Any unset (or only-unavailable / non-intentional) is unclassified.
 * All complete contexts intentional → intentional.
 */
export function classifyImageExposureBucket(
  targets: PostureTarget[],
): 'conflict' | 'intentional' | 'unclassified' {
  if (targets.some((t) => t.intentConflict)) return 'conflict';
  if (targets.length === 0) return 'unclassified';
  if (targets.some((t) => t.intentStatus === 'unset')) return 'unclassified';

  const complete = targets.filter((t) => t.intentStatus !== 'unavailable');
  if (complete.length === 0) return 'unclassified';
  if (complete.every(isIntentionalTarget)) return 'intentional';
  return 'unclassified';
}

function targetKey(t: PostureTarget): string {
  return `${t.imageRef}\0${t.stackName ?? ''}\0${t.serviceName ?? ''}`;
}

function pushUniqueTargets(into: PostureTarget[], rows: PostureTarget[]): void {
  const seen = new Set(into.map(targetKey));
  for (const t of rows) {
    const key = targetKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(t);
  }
}

/**
 * Split exposed Crit/High images into conflict / unclassified review / elevated EPSS.
 * Intentional exposure contributes only via elevated EPSS (or other independent
 * drivers computed outside this function: KEV, confirmed image update).
 */
export function classifyExposedImages(input: ClassifyExposedImagesInput): ClassifyExposedImagesResult {
  const {
    critHighByImage,
    exposedMap,
    targetsByImage,
    unsuppressedByImage,
    intel,
  } = input;

  let publiclyExposed = 0;
  const conflictTargets: PostureTarget[] = [];
  const unclassifiedTargets: PostureTarget[] = [];
  const elevatedTargets: PostureTarget[] = [];
  const elevatedDrivers: PostureDriverFinding[] = [];
  const conflictImages = new Set<string>();
  const unclassifiedImages = new Set<string>();
  const elevatedImages = new Set<string>();

  for (const imageRef of critHighByImage.keys()) {
    if (exposedMap.get(imageRef) !== true) continue;
    publiclyExposed += 1;

    const unsuppressed = unsuppressedByImage.get(imageRef) ?? [];
    if (unsuppressed.length === 0) continue;

    const targets = targetsByImage.get(imageRef) ?? [{ imageRef }];
    const bucket = classifyImageExposureBucket(targets);

    if (bucket === 'conflict') {
      conflictImages.add(imageRef);
      pushUniqueTargets(conflictTargets, targets);
    } else if (bucket === 'unclassified') {
      unclassifiedImages.add(imageRef);
      pushUniqueTargets(unclassifiedTargets, targets);
    }

    let hasHighEpss = false;
    for (const e of unsuppressed) {
      const epss = intel.get(e.vulnerability_id)?.epssScore ?? 0;
      if (epss < HIGH_EPSS_THRESHOLD) continue;
      hasHighEpss = true;
      elevatedDrivers.push({ vulnerabilityId: e.vulnerability_id, imageRef });
    }
    if (hasHighEpss) {
      elevatedImages.add(imageRef);
      pushUniqueTargets(elevatedTargets, targets);
    }
  }

  const elevated = capDriverFindings(elevatedDrivers);
  return {
    publiclyExposed,
    exposureIntentConflict: conflictImages.size,
    exposureIntentConflictTargets: conflictTargets,
    exposedUnclassified: unclassifiedImages.size,
    exposedUnclassifiedTargets: unclassifiedTargets,
    elevatedExploitRisk: elevatedImages.size,
    elevatedExploitRiskTargets: elevatedTargets,
    elevatedExploitRiskDrivers: elevated.drivers,
    elevatedExploitRiskDriverCount: elevated.driverCount,
    elevatedExploitRiskDriversTruncated: elevated.driversTruncated,
  };
}

/** Cap unsuppressed KEV driver rows for posture attachment. */
export function collectKevDrivers(
  drivers: Array<{ imageRef: string; vulnerability_id: string; suppressed?: boolean }>,
): CappedDrivers {
  const out: PostureDriverFinding[] = [];
  for (const e of drivers) {
    if (e.suppressed) continue;
    out.push({ vulnerabilityId: e.vulnerability_id, imageRef: e.imageRef });
  }
  return capDriverFindings(out);
}

/** Package-fix finding drivers for the given image refs (order preserved per image list). */
export function collectPackageFixDrivers(
  packageFixByImage: Map<string, string[]>,
  imageRefs: string[],
): CappedDrivers {
  const out: PostureDriverFinding[] = [];
  for (const imageRef of imageRefs) {
    for (const vulnerabilityId of packageFixByImage.get(imageRef) ?? []) {
      out.push({ vulnerabilityId, imageRef });
    }
  }
  return capDriverFindings(out);
}
