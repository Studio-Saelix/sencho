import { DatabaseService } from './DatabaseService';
import TrivyService from './TrivyService';
import { FleetSyncService } from './FleetSyncService';
import { applySuppressions, countsTowardResidualCriticalHigh } from '../utils/suppression-filter';
import { applyMisconfigAcknowledgements } from '../utils/misconfig-ack-filter';
import {
  deriveSecurityPosture,
  derivePostureReasons,
  type SecurityPostureFacts,
  type SecurityPostureState,
  type PostureReason,
  type PostureAction,
  type PostureTarget,
} from './securityPosture';
import { classifyImageRemediation, type RemediationFindingInput } from './securityImageRemediation';
import { ImageUpdateService } from './ImageUpdateService';
import { buildExposedImageMap, type StackExposure } from './preflight/exposure';
import { buildSecurityExposureTargets } from './securityExposureTargets';
import {
  classifyExposedImages,
  collectKevDrivers,
  collectPackageFixDrivers,
} from './securityExposureClassification';

// A completed scan whose latest run is older than this is considered "stale" in
// the Security overview. Distinct from the same-named 15-minute constant in
// SchedulerService, which marks in-flight scans failed.
export const STALE_SCAN_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Shape of the /overview response. Mirrors the frontend `SecurityOverview` type
// (frontend/src/types/security.ts); annotating the builder's return makes a
// renamed or dropped field a compile error here instead of an undefined read in
// the UI. Keep the two in sync.
export interface SecurityOverviewResponse {
  scannedImages: number;
  critical: number;
  high: number;
  fixable: number;
  secrets: number;
  misconfigs: number;
  staleScans: number;
  failedScans: number;
  lastSuccessfulScanAt: number | null;
  scanner: { available: boolean; version: string | null; source: 'managed' | 'host' | 'none'; autoUpdate: boolean };
  deployEnforcement: { honorSuppressionsOnDeploy: boolean; eligibleBlockPolicies: number };
  // Posture facts. Counts are facts; the verb (`posture`) is derived in one
  // place (`deriveSecurityPosture`). `critical`/`high` above stay for back-compat
  // and are relabeled "scanner detections" in the UI; `rawCritical`/`rawHigh`
  // are their posture-named aliases. `knownExploited` and `publiclyExposed` come
  // online with the CVE-intel and Compose-exposure phases (0 until then).
  rawCritical: number;
  rawHigh: number;
  fixableCriticalHigh: number;
  knownExploited: number;
  publiclyExposed: number;
  dangerousCompose: number;
  needsReview: number;
  accepted: number;
  notAffected: number;
  /**
   * Legacy mixed-unit sum of canonical blocker counts (image updates, secrets,
   * Compose, KEV, elevated EPSS, intent conflict). Prefer posture / reasons.
   */
  actionable: number;
  posture: SecurityPostureState;
  /** True when the bounded posture pass hit its row cap on this node. */
  posturePartial: boolean;
  /** Structured reasons explaining the posture (blockers, review, info). */
  postureReasons: PostureReason[];
  /** Highest-priority action for the masthead CTA, or null when no blockers. */
  primaryAction: PostureAction | null;
  /** True when image-update checks are disabled and uncertain remediation exists. */
  updateChecksDisabled?: boolean;
}

/**
 * Node-scoped security posture rollup for the Security page Overview, served by
 * GET /api/security/overview.
 *
 * Counts derive from the latest-completed-scan-per-image summaries plus two
 * precise helpers; the deploy-enforcement block is this node's read-only
 * posture, not policy management.
 */
export function buildSecurityOverview(nodeId: number): SecurityOverviewResponse {
    const db = DatabaseService.getInstance();
    const summaries = Object.values(db.getImageScanSummaries(nodeId));
    const settings = db.getGlobalSettings();
    const svc = TrivyService.getInstance();

    const now = Date.now();
    let scannedImages = 0;
    let critical = 0;
    let high = 0;
    let fixable = 0;
    let secrets = 0;
    let misconfigs = 0;
    let staleScans = 0;
    let lastSuccessfulScanAt: number | null = null;

    for (const s of summaries) {
      // Severity, secret, and misconfig totals are summed across every summary
      // (real images and stack/config scans alike). Only scannedImages excludes
      // the stack/config rows (stored under a "stack:" image_ref), since those
      // are stacks, not images.
      if (!s.image_ref.startsWith('stack:')) scannedImages += 1;
      critical += s.critical;
      high += s.high;
      fixable += s.fixable;
      secrets += s.secret_count;
      misconfigs += s.misconfig_count;
      if (now - s.scanned_at > STALE_SCAN_THRESHOLD_MS) staleScans += 1;
      if (lastSuccessfulScanAt === null || s.scanned_at > lastSuccessfulScanAt) {
        lastSuccessfulScanAt = s.scanned_at;
      }
    }

    // Posture facts that depend on suppressions/acks (which change without a
    // rescan) are computed at read time over a bounded set of Critical/High
    // findings, grouped per image so the existing read-time filters apply
    // unchanged. The pass is capped; `posturePartial` flags a truncated node.
    const cveSuppressions = db.getCveSuppressions();
    const critHigh = db.getLatestCritHighVulnFindingsForNode(nodeId);
    // Exploit intel is joined at read time by CVE id (never frozen onto the row).
    const intel = db.getCveIntel(critHigh.items.map((f) => f.vulnerability_id));
    const critHighByImage = new Map<string, Array<{ vulnerability_id: string; pkg_name: string; fixed_version: string | null }>>();
    for (const f of critHigh.items) {
      const group = critHighByImage.get(f.image_ref);
      if (group) group.push(f);
      else critHighByImage.set(f.image_ref, [f]);
    }
    let fixableCriticalHigh = 0;
    let residualCriticalHigh = 0;
    let accepted = 0;
    let notAffected = 0;
    let needsReview = 0;
    const remediationByImage = new Map<string, number>();
    const packageFixByImage = new Map<string, string[]>();
    for (const [imageRef, group] of critHighByImage) {
      for (const e of applySuppressions(group, imageRef, cveSuppressions)) {
        if (e.triage_status === 'needs_review') needsReview += 1;
        if (countsTowardResidualCriticalHigh(e)) {
          residualCriticalHigh += 1;
        }
        if (e.suppressed) {
          // A dismissing decision: not_affected is its own fact, the rest are "accepted".
          if (e.triage_status === 'not_affected') notAffected += 1;
          else accepted += 1;
          continue;
        }
        // Not dismissed (no decision, needs_review, or affected): still actionable.
        if (e.fixed_version) {
          fixableCriticalHigh += 1;
          remediationByImage.set(imageRef, (remediationByImage.get(imageRef) ?? 0) + 1);
          const vids = packageFixByImage.get(imageRef);
          if (vids) vids.push(e.vulnerability_id);
          else packageFixByImage.set(imageRef, [e.vulnerability_id]);
        }
      }
    }

    const remediationFindings: RemediationFindingInput[] = [];
    for (const [image_ref, count] of remediationByImage) {
      remediationFindings.push({ image_ref, count });
    }
    const imageUpdateSvc = ImageUpdateService.getInstance();
    const remediation = classifyImageRemediation({
      findings: remediationFindings,
      details: db.getStackUpdateDetail(nodeId),
      checksEnabled: ImageUpdateService.isChecksEnabled(),
      freshnessWindowMs: imageUpdateSvc.getRemediationFreshnessWindowMs(),
      now: Date.now(),
    });
    const updateAvailableDrivers = collectPackageFixDrivers(
      packageFixByImage,
      remediation.imageRefsUpdateAvailable,
    );
    const waitingUpstreamDrivers = collectPackageFixDrivers(
      packageFixByImage,
      remediation.imageRefsWaitingUpstream,
    );
    const updateUnknownDrivers = collectPackageFixDrivers(
      packageFixByImage,
      remediation.imageRefsUpdateUnknown,
    );

    // A known-exploited (KEV) finding gates a deploy at ANY severity, so the
    // posture fact counts non-suppressed KEV findings across all severities, not
    // just Critical/High. Sourced from its own latest-scan query so a Low/Medium
    // KEV that the gate would block on is never invisible on the overview.
    const kevFindings = db.getLatestKevFindingsForNode(nodeId);
    const kevByImage = new Map<string, typeof kevFindings.items>();
    for (const f of kevFindings.items) {
      const group = kevByImage.get(f.image_ref);
      if (group) group.push(f);
      else kevByImage.set(f.image_ref, [f]);
    }
    let knownExploited = 0;
    const knownExploitedTargets: string[] = [];
    const kevDriverRows: Array<{ imageRef: string; vulnerability_id: string }> = [];
    for (const [imageRef, group] of kevByImage) {
      let imageHasKev = false;
      for (const e of applySuppressions(group, imageRef, cveSuppressions)) {
        if (e.suppressed) continue;
        knownExploited += 1;
        imageHasKev = true;
        kevDriverRows.push({ imageRef, vulnerability_id: e.vulnerability_id });
      }
      if (imageHasKev) knownExploitedTargets.push(imageRef);
    }
    const knownExploitedDrivers = collectKevDrivers(kevDriverRows);

    const acks = db.getMisconfigAcknowledgements();
    const highMisconfigs = db.getLatestHighMisconfigFindingsForNode(nodeId);
    const misconfigByStack = new Map<string | null, Array<{ rule_id: string }>>();
    for (const f of highMisconfigs.items) {
      const group = misconfigByStack.get(f.stack_context);
      if (group) group.push(f);
      else misconfigByStack.set(f.stack_context, [f]);
    }
    let dangerousCompose = 0;
    for (const [stackContext, group] of misconfigByStack) {
      for (const e of applyMisconfigAcknowledgements(group, stackContext, acks)) {
        if (!e.acknowledged) dangerousCompose += 1;
      }
    }

    // Network-exposed image classification from cached Compose descriptors.
    // Intentional exposure is risk context, never an independent Action-needed
    // blocker. Package fixed_version alone cannot manufacture exposed blockers.
    const exposures = db.getStackExposures(nodeId);
    const parsedExposures: StackExposure[] = exposures.map((r) => {
      try { return JSON.parse(r.descriptor) as StackExposure; } catch { return null; }
    }).filter((e): e is StackExposure => e !== null);
    const exposedMap = buildExposedImageMap(parsedExposures);

    const unsuppressedByImage = new Map<string, Array<{ vulnerability_id: string }>>();
    const exposedImageRefs = new Set<string>();
    for (const [imageRef, group] of critHighByImage) {
      if (exposedMap.get(imageRef) !== true) continue;
      exposedImageRefs.add(imageRef);
      const kept: Array<{ vulnerability_id: string }> = [];
      for (const e of applySuppressions(group, imageRef, cveSuppressions)) {
        if (!e.suppressed) kept.push({ vulnerability_id: e.vulnerability_id });
      }
      unsuppressedByImage.set(imageRef, kept);
    }

    const allExposedTargets = buildSecurityExposureTargets({
      nodeId: nodeId,
      exposures: parsedExposures,
      qualifyingImageRefs: exposedImageRefs,
    });
    const targetsByImage = new Map<string, PostureTarget[]>();
    for (const t of allExposedTargets) {
      const group = targetsByImage.get(t.imageRef);
      if (group) group.push(t);
      else targetsByImage.set(t.imageRef, [t]);
    }

    const {
      publiclyExposed,
      exposureIntentConflict,
      exposureIntentConflictTargets,
      exposedUnclassified,
      exposedUnclassifiedTargets,
      elevatedExploitRisk,
      elevatedExploitRiskTargets,
      elevatedExploitRiskDrivers,
      elevatedExploitRiskDriverCount,
      elevatedExploitRiskDriversTruncated,
    } = classifyExposedImages({
      critHighByImage,
      exposedMap,
      targetsByImage,
      unsuppressedByImage,
      intel,
    });

    const failedScans = db.countScansByStatus(nodeId, 'failed');

    const postureFacts: SecurityPostureFacts = {
      scannerAvailable: svc.isTrivyAvailable(),
      hasCompletedScan: lastSuccessfulScanAt !== null,
      fixableCriticalHigh,
      fixableWithImageUpdate: remediation.fixableWithImageUpdate,
      fixableWaitingUpstream: remediation.fixableWaitingUpstream,
      fixableUpdateUnknown: remediation.fixableUpdateUnknown,
      updateChecksDisabled: remediation.updateChecksDisabled,
      secrets,
      dangerousCompose,
      knownExploited,
      publiclyExposed,
      exposureIntentConflict,
      exposedUnclassified,
      elevatedExploitRisk,
      rawCritical: critical,
      rawHigh: high,
      residualCriticalHigh,
      staleScans,
      failedScans,
      needsReview,
      fixableWithImageUpdateTargets: remediation.imageRefsUpdateAvailable,
      fixableWaitingUpstreamTargets: remediation.imageRefsWaitingUpstream,
      fixableUpdateUnknownTargets: remediation.imageRefsUpdateUnknown,
      knownExploitedTargets,
      knownExploitedDrivers: knownExploitedDrivers.drivers,
      knownExploitedDriverCount: knownExploitedDrivers.driverCount,
      knownExploitedDriversTruncated: knownExploitedDrivers.driversTruncated,
      exposureIntentConflictTargets,
      exposedUnclassifiedTargets,
      elevatedExploitRiskTargets,
      elevatedExploitRiskDrivers,
      elevatedExploitRiskDriverCount,
      elevatedExploitRiskDriversTruncated,
      fixableWithImageUpdateDrivers: updateAvailableDrivers.drivers,
      fixableWithImageUpdateDriverCount: updateAvailableDrivers.driverCount,
      fixableWithImageUpdateDriversTruncated: updateAvailableDrivers.driversTruncated,
      fixableWaitingUpstreamDrivers: waitingUpstreamDrivers.drivers,
      fixableWaitingUpstreamDriverCount: waitingUpstreamDrivers.driverCount,
      fixableWaitingUpstreamDriversTruncated: waitingUpstreamDrivers.driversTruncated,
      fixableUpdateUnknownDrivers: updateUnknownDrivers.drivers,
      fixableUpdateUnknownDriverCount: updateUnknownDrivers.driverCount,
      fixableUpdateUnknownDriversTruncated: updateUnknownDrivers.driversTruncated,
    };
    const posture = deriveSecurityPosture(postureFacts);
    const { reasons: postureReasons, primaryAction, targetsTruncated } = derivePostureReasons(postureFacts);
    // Legacy mixed-unit sum of blocker counts (not a distinct product metric).
    // Prefer posture / postureReasons. Intentional exposure alone is excluded.
    const actionable = remediation.fixableWithImageUpdate
      + secrets
      + dangerousCompose
      + knownExploited
      + elevatedExploitRisk
      + exposureIntentConflict;

    const overview: SecurityOverviewResponse = {
      scannedImages,
      critical,
      high,
      fixable,
      secrets,
      misconfigs,
      staleScans,
      failedScans,
      lastSuccessfulScanAt,
      scanner: {
        available: svc.isTrivyAvailable(),
        version: svc.getVersion(),
        source: svc.getSource(),
        autoUpdate: settings.trivy_auto_update === '1',
      },
      deployEnforcement: {
        honorSuppressionsOnDeploy: settings.deploy_block_honor_suppressions === '1',
        eligibleBlockPolicies: db.countEligibleBlockPolicies(
          nodeId,
          FleetSyncService.getRole(),
          FleetSyncService.getSelfIdentity(),
        ),
      },
      rawCritical: critical,
      rawHigh: high,
      fixableCriticalHigh,
      knownExploited,
      publiclyExposed,
      dangerousCompose,
      needsReview,
      accepted,
      notAffected,
      actionable,
      posture,
      posturePartial: critHigh.truncated || kevFindings.truncated || highMisconfigs.truncated || targetsTruncated,
      postureReasons,
      primaryAction,
      updateChecksDisabled: remediation.updateChecksDisabled,
    };
  return overview;
}
