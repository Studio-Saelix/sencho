/**
 * Pre-deploy policy gate.
 *
 * Extracted from `index.ts` so route handlers and the scheduler can call a
 * single, unit-testable function rather than copy-paste the gate logic.
 *
 * The gate fails open when Trivy is missing (users are never locked out by
 * tooling state) and fails closed when the compose file cannot be parsed
 * (a broken stack must not silently bypass a block policy).
 */
import { ComposeService } from './ComposeService';
import { DatabaseService } from './DatabaseService';
import type { ScanPolicy, VulnSeverity, VulnerabilityScan, VulnerabilityDetail } from './DatabaseService';
import { FleetSyncService } from './FleetSyncService';
import { NotificationService } from './NotificationService';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import TrivyService from './TrivyService';
import { isSeverityAtLeast } from '../utils/severity';
import { applySuppressions, mayDismissOnImage } from '../utils/suppression-filter';
import { validateImageRef } from '../utils/image-ref';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import {
    evaluatePolicyRisk,
    describePolicyInputs,
    describeReason,
    policyInputs,
    type PolicyBlockReason,
    type PolicyRiskInputs,
} from '../utils/policy-risk';
import { allowedPolicyEvidence, type AllowedPolicyEvidence } from './allowedPolicyEvidence';
import {
    classifyScanEvidence,
    classifyScannerEvidence,
    decideEvidenceGate,
    isCleanEvidenceDecision,
    NODE_WIDE_EVIDENCE_TARGET,
    summarizeEvidenceApplications,
    type EvidenceAvailabilityOutcome,
    type EvidenceGateDecision,
    type EvidenceRuleApplication,
    type SecurityEvidenceRecord,
    type SecurityEvidenceSource,
    type SecurityEvidenceState,
} from './securityEvidence';
import {
    effectiveServicePlatform,
    isLatestImageTag,
    localImageExists,
    localImageLastTagTime,
    nodePlatformFor,
    normalizedPullPolicy,
    pullPolicyRefreshAfterMs,
    pullPolicyRefreshDue,
    resolveCandidateImage,
    type CandidateResolution,
    type ImageSource,
} from './candidateImage';
import { buildEffectiveServiceModel, type EffectiveServiceSpec } from './effectiveServiceModel';
import {
    resolveSecurityEvidencePolicy,
    type SecurityEvidencePolicy,
} from './securityEvidencePolicy';

export interface PolicyViolation {
    imageRef: string;
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    /** Non-suppressed CVEs in the CISA known-exploited (KEV) set on this image. */
    kevCount: number;
    /** Non-suppressed Critical/High findings with a fix available on this image. */
    fixableCount: number;
    /** Which policy inputs matched (empty when the image could not be scanned). */
    reasons: PolicyBlockReason[];
    scanId: number;
    /**
     * The platform variant this row is about, when the gate resolved or tried
     * to resolve a registry candidate. A ref shared by services with different
     * `platform:` overrides produces one row per variant, so the dialog pairs
     * each row with its own evidence rather than the first record for the ref.
     */
    platform?: string | null;
    /**
     * Why the block is unactionable by policy: set when the gate blocked because
     * the image could not be scanned or evaluated (compose parse error, scan
     * failure, evaluation error), not because a policy input matched. Absent for
     * a normal policy match. Lets the UI explain the failure instead of showing a
     * zero-count block with no reason.
     */
    error?: string;
}

export interface PolicyEnforcementOptions {
    bypass: boolean;
    actor: string;
    ip?: string;
    /**
     * Which image the operation will run. Defaults to `installed`, which is what
     * the node holds now and what every path evaluated before candidate
     * resolution existed. A path that pulls sets `registry` or `compose`, and
     * the gate decides per service whether the operation fetches the registry
     * image or runs the installed one.
     */
    imageSource?: ImageSource;
    /**
     * True when no person is in the loop (auto-update, scheduled run, webhook,
     * Git source, mesh). Read when `imageSource` is not `installed` or when
     * `pulledCandidate` is set: an unattended path cannot ask anyone, so unproven
     * candidate evidence is held by the Candidate not evaluated rule rather than
     * the attended Scan failed rule.
     */
    unattended?: boolean;
    /**
     * The installed image being scanned is the candidate this operation just
     * pulled, after the pull showed a different digest than the gate evaluated.
     * It is evaluated as an installed image (that is where it lives now) but the
     * evidence keeps candidate semantics, so an unattended update still holds it
     * under Candidate not evaluated rather than the attended rule.
     */
    pulledCandidate?: boolean;
    /** HTTP method of the originating request; used for audit attribution. */
    auditMethod?: string;
    /** Request path of the originating route; used for audit attribution. */
    auditPath?: string;
    /**
     * Rollback compensation: list images via this captured Compose invocation
     * instead of the live database-derived args.
     */
    composeInvocation?: RollbackInvocationRecord | null;
    /**
     * Whether this call stands for an operation that goes ahead. Defaults to on.
     * A read-only probe that asks "would this be allowed" and runs repeatedly
     * (rollback readiness, a dry-run, a pre-check whose apply evaluates again)
     * sets it to false: it allowed nothing, so it leaves no evidence audit row, no
     * suppression-pass row, and no "proceeded on incomplete evidence" alert. A
     * row or an alert per probe would bury the ones for real operations.
     */
    recordAllowedEvidence?: boolean;
    /**
     * Called once with the decision when the gate allows on evidence that was not
     * a clean pass, or when an authorized bypass was used. Lets a handler that
     * reaches the gate through a service several calls deep (rollback compensate,
     * the update orchestrator, automatic update) put the decision in its response
     * without threading a return value through every layer in between.
     */
    onAllowed?: (allowed: AllowedPolicyEvidence) => void;
}

export interface PolicyEnforcementResult {
    ok: boolean;
    bypassed: boolean;
    policy?: ScanPolicy;
    violations: PolicyViolation[];
    /**
     * True when the deploy was allowed because no scanner could run, which is
     * distinct from "no policy matched" and from "every image was scanned and
     * clean". Set only on an allow; when the policy blocks on an unavailable
     * scanner this stays absent and `violations` carries the refusal.
     */
    trivyMissing?: boolean;
    /**
     * The evidence half of the decision: what each required source actually
     * reported, and which configured rule turned that into the outcome. Absent
     * when the gate short-circuited before any evidence was required.
     */
    evidence?: EvidenceGateDecision;
    /**
     * The registry candidates this decision evaluated, when the operation will
     * pull. The pull executor compares the digests it actually fetched against
     * these before recreating anything: a tag can move between the gate and the
     * pull, and the image that lands must be the image that was proven.
     */
    evaluatedCandidates?: EvaluatedCandidate[];
    /**
     * Compose services the operation will fetch, including a service whose
     * digest-pinned image Compose fetches by digest. A plain-up deploy pulls
     * these before running `up` with pulls disabled.
     */
    pullServices?: string[];
    /**
     * A plain `up` must not fetch on its own. Set when an interval policy is not
     * due yet: the gate evaluated the installed image, and Compose must not pull
     * a different one if the interval expires before `up` starts. Also set when
     * the effective model did not render in compose mode, where no reference can
     * be attributed to a service for a targeted pull.
     */
    noPullOnUp?: boolean;
}

/** One registry candidate a gate decision covered. */
export interface EvaluatedCandidate {
    ref: string;
    /** The digest the tag resolved to when the gate ran. */
    indexDigest: string;
    /** The platform child digest that was scanned. */
    platformDigest: string;
    /**
     * Compose services this operation will fetch the ref through. A plain-up
     * deploy pulls exactly these services before it runs `up` with pulls
     * disabled; empty when the caller supplied references without a model
     * (Blueprint preflight, GitOps acceptance).
     */
    services?: string[];
}

/**
 * Candidate (pre-acceptance) policy outcome. Unlike the deploy-time gate,
 * which deliberately fails open when the scanner is unavailable so an
 * operator is never blocked from deploying, an unresolvable scanner state
 * here is its own outcome: automatic source acceptance must not read
 * `unavailable` as `allowed`, or a GitOps source could accept a candidate
 * nothing actually proved safe.
 */
export type CandidatePolicyEvaluation = { policy?: ScanPolicy; evidence?: EvidenceGateDecision } & (
    | { status: 'allowed' }
    | { status: 'blocked'; violations: PolicyViolation[] }
    | { status: 'unavailable'; reason: string }
);

const TRIVY_MISSING_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
// Growth bounded by configured-policy fanout (only stacks with an enabled
// block_on_deploy policy can land here), not by total stack churn. Cleared
// on process restart, which is the right scope for an informational warning.
const trivyMissingNotifiedAt = new Map<string, number>();

// Growth bounded the same way as trivyMissingNotifiedAt: by configured-policy
// fanout over distinct (node, stack, reason) triples, not by total stack churn.
const evidenceWarnedAt = new Map<string, number>();

function notifyTrivyMissingOnce(nodeId: number, stackName: string): void {
    const key = `${nodeId}:${stackName}`;
    const now = Date.now();
    const last = trivyMissingNotifiedAt.get(key);
    if (last !== undefined && now - last < TRIVY_MISSING_NOTIFY_COOLDOWN_MS) return;
    trivyMissingNotifiedAt.set(key, now);
    NotificationService.getInstance().dispatchAlert(
        'warning',
        'scan_finding',
        `Pre-deploy scan for "${stackName}" skipped: Trivy not installed on this node`,
        { stackName, actor: 'system:policy' },
    );
}

export function _resetTrivyMissingNotificationStateForTests(): void {
    trivyMissingNotifiedAt.clear();
    evidenceWarnedAt.clear();
}

/**
 * One warning alert per node/stack/reason per hour. Shares the trivy-missing
 * cooldown because it answers the same operator question ("this deploy went
 * through on evidence you may not trust") and the same flood risk: the gate runs
 * on every mutation path, and an unbounded notifier here would turn one
 * misconfigured threshold into an alert storm.
 */
function notifyEvidenceWarningOnce(nodeId: number, stackName: string, rule: string, detail: string): void {
    // Keyed by the rule that fired, never by the interpolated detail: a key
    // carrying an image reference or a summary sentence would grow one entry per
    // distinct string the process ever produced.
    const key = `${nodeId}:${stackName}:${rule}`;
    const now = Date.now();
    const last = evidenceWarnedAt.get(key);
    if (last !== undefined && now - last < TRIVY_MISSING_NOTIFY_COOLDOWN_MS) return;
    evidenceWarnedAt.set(key, now);
    NotificationService.getInstance().dispatchAlert(
        'warning',
        'scan_finding',
        `Pre-deploy scan for "${stackName}" proceeded on incomplete evidence: ${detail}`,
        { stackName, actor: 'system:policy' },
    );
}

/**
 * Read the instance's evidence-availability policy.
 *
 * A settings read that throws resolves to the shipped defaults rather than
 * propagating. The deploy path cannot afford an unrelated database error to
 * become a deploy failure, and the defaults are the documented operator-visible
 * behaviour, so the decision stays attributable either way.
 */
/**
 * Everything this gate reads from `global_settings`, resolved in one guarded
 * pass. Reading it twice would leave the second read outside the guard, and an
 * unrelated database error there would surface as a failed deploy rather than a
 * documented default.
 */
interface GateSettings {
    evidencePolicy: SecurityEvidencePolicy;
    honorSuppressions: boolean;
}

function loadGateSettings(): GateSettings {
    try {
        const settings = DatabaseService.getInstance().getGlobalSettings();
        return {
            evidencePolicy: resolveSecurityEvidencePolicy(settings),
            // Read in the same guarded pass. Honoring suppressions weakens a
            // deploy block, so its default is the strict one: an unreadable
            // setting must not quietly start suppressing.
            honorSuppressions: settings['deploy_block_honor_suppressions'] === '1',
        };
    } catch (err) {
        console.error(
            '[Policy] Gate settings read failed; falling back to the documented defaults:',
            getErrorMessage(err, 'settings read failed'),
        );
        return {
            evidencePolicy: resolveSecurityEvidencePolicy(null),
            honorSuppressions: false,
        };
    }
}

/** Audit-readable name for the rule that produced an outcome. */
function ruleClause(key: string, outcome: EvidenceAvailabilityOutcome): string {
    return `${key}=${outcome}`;
}

/** One synthetic violation standing in for "the evidence could not be obtained". */
function unavailableViolation(
    imageRef: string,
    message: string,
    platform?: string | null,
): PolicyViolation {
    return {
        imageRef,
        severity: 'UNKNOWN',
        criticalCount: 0,
        highCount: 0,
        kevCount: 0,
        fixableCount: 0,
        reasons: [],
        scanId: 0,
        ...(platform ? { platform } : {}),
        error: message,
    };
}

/**
 * Decide what an unavailable scanner means for this deploy.
 *
 * This is the branch that used to be a bare `if` returning `ok: true`. The
 * operator-facing behaviour is unchanged at every setting value it shipped with
 * (`allow` plus an hourly warning alert); what changed is that the reason is now
 * a recorded fact rather than an accident of which `if` executed. The deploy
 * path answers `trivyMissing`, the candidate path answers `unavailable`, and
 * neither is reachable from the other.
 */
function decideScannerUnavailable(
    policy: ScanPolicy,
    evidencePolicy: SecurityEvidencePolicy,
    nodeId: number,
    stackName: string,
    opts: PolicyEnforcementOptions,
): PolicyEnforcementResult {
    // An unattended pulling path has its own rule for "no evidence at all", and
    // for the same reason the GitOps candidate path does: a setting an operator
    // relaxes to get past a scanner outage at the keyboard must not become
    // standing authority for an automation to install an image nothing proved.
    const unattendedCandidate = isUnattendedCandidatePath(opts);
    const outcome = unattendedCandidate ? evidencePolicy.candidateUnproven : evidencePolicy.scannerUnavailable;
    const rule = unattendedCandidate
        ? ruleClause('security_candidate_unproven', outcome)
        : ruleClause('security_scanner_unavailable', outcome);
    const classification = classifyScannerEvidence({ available: false, collectedAt: null });
    const records: SecurityEvidenceRecord[] = [
        {
            source: 'scanner_availability',
            state: classification.state,
            target: NODE_WIDE_EVIDENCE_TARGET,
            collectedAt: null,
            reason: classification.reason,
        },
    ];
    const decision = decideEvidenceGate(records, [
        {
            source: 'scanner_availability',
            state: classification.state,
            outcome,
            rule,
        },
    ]);

    notifyTrivyMissingOnce(nodeId, stackName);

    if (decision.outcome === 'block') {
        // Every other refusal in this evaluator honors an authorized bypass
        // before it returns, and this one has to as well: an operator who has
        // configured `block` is expressing a default, not revoking the escape
        // hatch that every other branch keeps. Without this the setting would
        // silently strand a node whose scanner is missing.
        if (opts.bypass) {
            // Audited like every other bypass. An admin proceeding past a gate
            // is the same event here as anywhere else, and the reason it was
            // needed (no scanner on this node) is exactly what an incident
            // review will want to see.
            recordBypassAudit(stackName, nodeId, policy, [], opts, decision);
            return { ok: true, bypassed: true, policy, violations: [], trivyMissing: true, evidence: decision };
        }
        console.warn(
            '[Policy] Blocked deploy for "%s": the vulnerability scanner is unavailable and the configured policy blocks (policy "%s")',
            sanitizeForLog(stackName), sanitizeForLog(policy.name),
        );
        return {
            ok: false,
            bypassed: false,
            policy,
            // The row names the cause; the rule that decided is in `evidence` and
            // is shown in its own section, so it is not repeated in this text.
            violations: [unavailableViolation('(scanner unavailable)', classification.reason ?? 'The vulnerability scanner is not available on this node')],
            evidence: decision,
        };
    }

    return { ok: true, bypassed: false, policy, violations: [], trivyMissing: true, evidence: decision };
}

type PreflightScan = Pick<VulnerabilityScan, 'id' | 'highest_severity' | 'critical_count' | 'high_count' | 'total_vulnerabilities'>;

/** True when this decision covers an image an unattended operation will pull. */
function isUnattendedCandidatePath(opts: PolicyEnforcementOptions): boolean {
    if (opts.unattended !== true) return false;
    return (opts.imageSource ?? 'installed') !== 'installed' || opts.pulledCandidate === true;
}

/**
 * The configured rule and its key for "evidence about the image could not be
 * obtained". Attended operations ask the Scan failed setting (a person can retry
 * or accept the risk); unattended pulling operations ask Candidate not evaluated,
 * because nobody is there to answer and the image was never on the node before.
 */
function failureRule(
    evidencePolicy: SecurityEvidencePolicy,
    opts: PolicyEnforcementOptions,
): { key: string; outcome: EvidenceAvailabilityOutcome } {
    return isUnattendedCandidatePath(opts)
        ? { key: 'security_candidate_unproven', outcome: evidencePolicy.candidateUnproven }
        : { key: 'security_scan_failure', outcome: evidencePolicy.scanFailure };
}

/** One reference's role for this gate call. */
type CandidatePlanEntry =
    | { kind: 'installed'; why: 'digest_pinned' | 'not_pulled' | 'build' }
    | {
        kind: 'candidate';
        resolution: CandidateResolution & { kind: 'candidate' };
        /** Compose services this operation will fetch this ref through. */
        services: string[];
    }
    | {
        kind: 'unresolved';
        resolution: CandidateResolution & { kind: 'unresolved' };
        /** The platform variant the gate could not resolve, when it asked for one. */
        platform?: string | null;
    };

/**
 * The build service whose image Compose generates for `ref`, if any.
 *
 * A build-only service declares no image; Compose names the image it builds
 * `<project>-<service>` and `config --images` reports it. That name is not a
 * registry reference the operation may fetch: pulling it would either fail or
 * install an unrelated public image from the default registry. The rendered
 * model normally states the project name. When it does not, the generated name
 * is still a bare repository ending in `-<service>`, and no service declares it,
 * so the suffix identifies the build service that produced it.
 */
function generatedBuildServiceFor(
    ref: string,
    services: readonly EffectiveServiceSpec[],
    projectName: string | null,
): EffectiveServiceSpec | undefined {
    // A generated name is always a bare repository (`<project>-<service>`,
    // optionally tagged). A registry-qualified reference or a digest pin cannot
    // be one.
    if (ref.includes('/') || ref.includes('@')) return undefined;
    const repository = ref.split(':')[0];
    return services.find((spec) => spec.hasBuild && (
        projectName !== null
            ? repository === `${projectName}-${spec.name}`
            : repository.endsWith(`-${spec.name}`)
    ));
}

/**
 * Decide, for each reference, whether this operation will run the registry image
 * or the one already on the node, and resolve the registry image.
 *
 * The plan is per service, from the fully rendered model, because a Compose
 * `pull_policy` decides whether an update's `pull` or a plain `up` fetches, and
 * a service-level `platform` decides which child of a multi-arch index Compose
 * resolves. When the caller supplied references without a model, as the
 * Blueprint preflight and GitOps acceptance do, every reference is treated as a
 * candidate: the stricter reading, because nothing then proves the operation
 * will not pull it. When the model was requested but could not be rendered, no
 * reference can be attributed to a service: a plain `up` keeps `up --pull never`
 * and evaluates the installed image, so a build-generated name is never fetched
 * by bare reference, while a registry update still resolves every reference
 * because its own pull is what could fetch one.
 *
 * A service that declares both `image:` and `build:` is not build-only: Compose
 * still tries its image under `always`, a due interval, or a missing local copy,
 * and a successful pull runs the registry image instead of building. A registry
 * update builds every build-backed service first and then pulls only the
 * non-build ones, so there the build wins and the installed image is what runs.
 */
async function planCandidates(
    nodeId: number,
    imageRefs: readonly string[],
    mode: Exclude<ImageSource, 'installed'>,
    modelServices: Awaited<ReturnType<typeof buildEffectiveServiceModel>> | null,
): Promise<{ plan: Map<string, CandidatePlanEntry[]>; pullServices: Set<string>; noPullOnUp: boolean }> {
    const plan = new Map<string, CandidatePlanEntry[]>();
    // Every service the operation will fetch, including a digest pin Compose
    // fetches by its pinned digest. The deploy executor pulls exactly these
    // before it runs `up` with pulls disabled.
    const pullServices = new Set<string>();
    let noPullOnUp = false;
    if (imageRefs.length === 0) return { plan, pullServices, noPullOnUp };
    const services = modelServices && modelServices.renderable ? modelServices.services : null;
    const projectName = modelServices && modelServices.renderable ? modelServices.projectName ?? null : null;
    const nodePlatform = await nodePlatformFor(nodeId);
    const registryMode = mode === 'registry';

    const resolveEntry = async (
        ref: string,
        serviceNames: string[] = [],
        platform: { os: string; architecture: string } | null = nodePlatform,
    ): Promise<CandidatePlanEntry> => {
        const resolution = await resolveCandidateImage(nodeId, ref, platform);
        if (resolution.kind === 'candidate') {
            for (const name of serviceNames) pullServices.add(name);
            return { kind: 'candidate', resolution, services: serviceNames };
        }
        if (resolution.kind === 'unresolved') return { kind: 'unresolved', resolution };
        // A digest pin is exact, so it is already the image the gate will run.
        // Compose may still fetch it when the local copy is missing; that fetch
        // belongs in the same pull boundary.
        if (resolution.why === 'digest_pinned') {
            for (const name of serviceNames) pullServices.add(name);
        }
        return { kind: 'installed', why: resolution.why };
    };

    for (const ref of imageRefs) {
        if (!services) {
            if (modelServices === null) {
                // The caller supplied references without a model (Blueprint
                // preflight, GitOps acceptance): there is no plain `up` boundary
                // to fetch them, so each is resolved as the caller asked.
                plan.set(ref, [await resolveEntry(ref)]);
                continue;
            }
            if (mode === 'compose') {
                // The effective model did not render, so no reference can be
                // attributed to a service for a targeted pull, and one of them
                // may be the image Compose generates for a build-only service
                // (`<project>-<service>`). Pulling that name would either fail or
                // install an unrelated public image from the default registry.
                // Keep `up --pull never` instead and evaluate the installed image;
                // a build may still fetch its own base images, but Compose cannot
                // fetch a service image behind the gate.
                noPullOnUp = true;
                plan.set(ref, [{ kind: 'installed', why: 'not_pulled' }]);
                continue;
            }
            // Registry mode: the update's own `compose pull` fetches these, and
            // the model cannot say which one it skips. Resolve each as a
            // candidate so nothing the pull fetches runs unevaluated.
            plan.set(ref, [await resolveEntry(ref)]);
            continue;
        }
        const declared = services.filter((spec) => spec.declaredImage === ref);
        if (declared.length === 0) {
            // A build-only service declares no image; Compose names the image it
            // builds `<project>-<service>` and `config --images` reports it. That
            // image does not exist until the build, so it is not a registry
            // candidate even though no service declares the reference.
            const generatedBuild = generatedBuildServiceFor(ref, services, projectName);
            if (generatedBuild) {
                plan.set(ref, [{ kind: 'installed', why: 'build' }]);
                continue;
            }
            // Any other reference came from Compose's own image list, so it is an
            // image this operation can install. Resolve it rather than assume
            // otherwise.
            plan.set(ref, [await resolveEntry(ref)]);
            continue;
        }
        if (registryMode && declared.every((spec) => spec.hasBuild)) {
            // A registry update builds every build-backed service before its
            // pull, and `pull --ignore-buildable` skips them, so this image does
            // not come from the registry on that path. Recorded as installed.
            plan.set(ref, [{ kind: 'installed', why: 'build' }]);
            continue;
        }
        // Both an update's `docker compose pull` and a plain `up` skip
        // `pull_policy: never`, even when the image is absent, so that service
        // never runs a registry image this gate could block on. `build` builds
        // instead of fetching. `missing` skips a present non-latest image in
        // both modes, while an explicit `pull` still refreshes a present
        // `latest` and treats interval policies as due. `up` uses the `missing`
        // default for a service with no policy and only refreshes an interval
        // policy once its window has elapsed. A service that also declares
        // `build:` is still fetched when its policy pulls or its image is
        // missing, because a successful pull runs the registry image instead of
        // the build; only `never` and `build` keep it on the build. An unknown
        // policy is treated as pulling (fail-closed).
        const runnable = registryMode ? declared.filter((spec) => !spec.hasBuild) : declared;
        if (runnable.length === 0) {
            plan.set(ref, [{ kind: 'installed', why: 'not_pulled' }]);
            continue;
        }
        const policies = runnable.map((spec) => normalizedPullPolicy(spec.pullPolicy));
        const isInterval = (policy: string): boolean =>
            pullPolicyRefreshAfterMs(policy) !== null || policy.startsWith('every_');
        // An interval policy that is not due now can become due while the scan
        // and deploy preparation run. The deploy must then keep `up` from
        // fetching the image the gate did not evaluate as a candidate.
        if (!registryMode && policies.some(isInterval)) noPullOnUp = true;
        // Only ask the daemon when the answer changes the decision. `always`
        // and `refresh` always fetch, and `never` and `build` never do, so none
        // of them needs the local copy.
        const needsPresence = (policy: string): boolean => {
            if (policy === 'always' || policy === 'refresh' || policy === 'never' || policy === 'build') return false;
            if (registryMode) return policy === 'missing' || policy === 'if_not_present';
            return true;
        };
        // Compose resolves the index for each service's own platform, so a ref
        // shared by services with different overrides has more than one image to
        // prove. Presence is a per-platform fact too: a local copy of another
        // platform's child does not stop Compose from fetching this one, so a
        // present ref is not the same as a present image for the service.
        const byPlatform = new Map<string, {
            platform: { os: string; architecture: string; variant?: string } | null;
            invalid?: string;
            services: EffectiveServiceSpec[];
        }>();
        for (const spec of runnable) {
            const effective = effectiveServicePlatform(spec.platform, nodePlatform);
            const key = effective.ok
                ? (effective.platform
                    ? `${effective.platform.os}/${effective.platform.architecture}${effective.platform.variant ? `/${effective.platform.variant}` : ''}`
                    : 'platform-unknown')
                : `invalid:${effective.reason}`;
            const group = byPlatform.get(key) ?? {
                platform: effective.ok ? effective.platform : null,
                ...(effective.ok ? {} : { invalid: effective.reason }),
                services: [],
            };
            group.services.push(spec);
            byPlatform.set(key, group);
        }
        const presentByPlatform = new Map<string, boolean>();
        const presenceFor = async (
            key: string,
            group: { platform: { os: string; architecture: string; variant?: string } | null; invalid?: string },
        ): Promise<boolean> => {
            const known = presentByPlatform.get(key);
            if (known !== undefined) return known;
            // An override this build cannot read is resolved as unresolved when
            // it pulls; presence is moot there and must not read as installed.
            const present = group.invalid || !group.platform
                ? false
                : await localImageExists(nodeId, ref, group.platform);
            presentByPlatform.set(key, present);
            return present;
        };
        let lastTagTime: number | null = null;
        let lastTagTimeRead = false;
        const lastTagTimeFor = async (): Promise<number | null> => {
            if (!lastTagTimeRead) {
                lastTagTime = await localImageLastTagTime(nodeId, ref);
                lastTagTimeRead = true;
            }
            return lastTagTime;
        };
        const entries: CandidatePlanEntry[] = [];
        for (const [key, group] of byPlatform) {
            const needsLocalCopy = group.services.some(
                (spec) => needsPresence(normalizedPullPolicy(spec.pullPolicy)),
            );
            const present = needsLocalCopy ? await presenceFor(key, group) : false;
            // The tag time is per reference, not per platform, so one read
            // serves every group that has a present image and an interval.
            const intervalTagTime = !registryMode && present
                && group.services.some((spec) => isInterval(normalizedPullPolicy(spec.pullPolicy)))
                ? await lastTagTimeFor()
                : null;
            const pullsFor = (spec: EffectiveServiceSpec): boolean => {
                const policy = normalizedPullPolicy(spec.pullPolicy);
                if (policy === 'never' || policy === 'build') return false;
                if (registryMode) {
                    if (spec.hasBuild) return false;
                    if (policy === '') return true;
                    if (policy === 'always') return true;
                    if (policy === 'missing' || policy === 'if_not_present') {
                        return !present || isLatestImageTag(ref);
                    }
                    return true;
                }
                if (policy === '') return !present;
                if (policy === 'always') return true;
                if (policy === 'missing' || policy === 'if_not_present') return !present;
                if (isInterval(policy)) return !present || pullPolicyRefreshDue(policy, intervalTagTime);
                return true;
            };
            const pulling = group.services.filter(pullsFor);
            if (pulling.length === 0) continue;
            if (group.invalid) {
                entries.push({
                    kind: 'unresolved',
                    resolution: {
                        kind: 'unresolved',
                        ref,
                        state: 'unknown',
                        failureClass: 'platform_ambiguity',
                        reason: `The image could not be resolved because ${group.invalid}`,
                    },
                });
                continue;
            }
            const entry = await resolveEntry(ref, pulling.map((spec) => spec.name), group.platform);
            // A resolution failure still belongs to the platform it was asked
            // for, so the record can name the variant the gate could not prove.
            entries.push(entry.kind === 'unresolved'
                ? {
                    ...entry,
                    platform: group.platform
                        ? `${group.platform.os}/${group.platform.architecture}${group.platform.variant ? `/${group.platform.variant}` : ''}`
                        : null,
                }
                : entry);
        }
        if (entries.length === 0) {
            // Compose will not fetch this image, so the node's own image is what runs.
            plan.set(ref, [{ kind: 'installed', why: 'not_pulled' }]);
        } else {
            plan.set(ref, entries);
        }
    }
    return { plan, pullServices, noPullOnUp };
}

interface ImageRiskEvaluation {
    /** Policy inputs that matched for this image. Those also listed in `unverified` were assumed or matched only provisionally. */
    reasons: PolicyBlockReason[];
    /** Highest non-suppressed severity; UNKNOWN means no severity remains. */
    severity: VulnSeverity;
    criticalCount: number;
    highCount: number;
    kevCount: number;
    fixableCount: number;
    /** CVE IDs suppressed for this image; only populated when honoring suppressions. */
    suppressedCves: string[];
    /** True when the same inputs would have matched if suppressions were ignored. */
    rawWouldBlock: boolean;
    /**
     * Set when the per-finding detail rows could not be trusted, which is the
     * `partial` evidence state. Severity still gates from the aggregate counts;
     * KEV and fixability cannot be read from aggregates, so the reason is
     * recorded rather than left invisible.
     */
    partialEvidenceReason?: string;
    /**
     * Log-only: the reasons in `reasons` that were not established on verified
     * evidence, and why. KEV/fixable are assumed because the detail rows could
     * not be trusted. `severity` is listed only when suppressions are honored and
     * some stored suppression may dismiss a finding on this image (assumed when the
     * suppressions could not be read): it matched on the raw aggregate, and that
     * suppression, which might lift it, could not be applied without the rows.
     * Never reaches the API: the violation keeps the plain `reasons`.
     */
    unverified?: { reasons: PolicyBlockReason[]; cause: string };
}

/**
 * The `partial` record's reason for an image whose finding rows could not be
 * trusted. Says what the gate actually did for this policy: it treats the
 * known-exploited and fixability inputs the policy enables as risky, and when it
 * enables neither, only the suppressions it could not apply are affected.
 */
function partialFindingsReason(what: string, inputs: PolicyRiskInputs): string {
    const enabled = [
        inputs.blockOnKev ? 'known-exploited' : null,
        inputs.blockOnFixable ? 'fixability' : null,
    ].filter((x): x is string => x !== null);
    if (enabled.length === 0) return `${what}, so suppressions could not be applied to every finding`;
    const verb = enabled.length > 1 ? 'were' : 'was';
    return `${what}, so ${enabled.join(' and ')} ${verb} treated as risky`;
}

/** Why `aggregateFallback` could not rely on the stored evidence: KEV/fixability, and suppressions when honored. */
const EVIDENCE_READ_FAILED = 'stored scan evidence could not be read';
const detailRowsTruncated = (stored: number, total: number): string =>
    `stored detail rows (${stored}) do not match the scan total (${total})`;

/**
 * Free text on a block line (an image reference, a scan or policy-evaluation
 * error) made safe for a single log line. Runs of line breaks and tabs become one
 * space and the ends are trimmed, so multi-line scanner output keeps its fields
 * apart (deleting them would fuse the image tag with the timestamp that follows
 * it). Credentials are redacted with any other control character still in place,
 * so one inside a credential cannot split it past the redaction. Those characters
 * then become spaces and the text is redacted again, for a credential that only
 * matches once a control character no longer separates its keyword from its value.
 */
function logEntry(text: string): string {
    const redacted = redactSensitiveText(text.replace(/[\t\n\v\f\r]+/g, ' ').trim());
    return sanitizeForLog(redactSensitiveText(redacted.replace(/[\x00-\x1F\x7F]+/g, ' ')));
}

/**
 * What one image's unverified-evidence entry says. KEV/fixable read "not
 * verified, <cause>"; a severity match made while honored suppressions could not
 * be applied reads "matched before suppressions could be applied"; a severity
 * match on verified evidence reads "matched". Parts are joined with "; ", and
 * the cause follows the first part that names an unverified input:
 * `<kev/fixable> not verified, <cause>[; <severity part>]` or
 * `<severity> matched before suppressions could be applied, <cause>`.
 */
function describeUnverified(
    violation: PolicyViolation,
    { reasons: unverified, cause }: NonNullable<ImageRiskEvaluation['unverified']>,
): string {
    const assumed = unverified.filter((r) => r !== 'severity');
    const parts: string[] = [];
    if (assumed.length > 0) parts.push(`${assumed.map(describeReason).join(', ')} not verified, ${cause}`);
    if (unverified.includes('severity')) {
        parts.push(`${describeReason('severity')} matched before suppressions could be applied${assumed.length > 0 ? '' : `, ${cause}`}`);
    } else if (violation.reasons.includes('severity')) {
        parts.push(`${describeReason('severity')} matched`);
    }
    return parts.join('; ');
}

interface SuppressionPass {
    imageRef: string;
    cves: string[];
}

/**
 * Aggregate-only evaluation. Two roles: the cheap fast path for a severity-only
 * policy that does not need detail rows (`failClosedCause=null`), and the fallback
 * when the detail rows cannot be trusted. The raw severity always gates, because
 * the stored aggregate counts still give it. KEV/fixability cannot be read from
 * aggregates: when `failClosedCause` is set the active KEV/fixable inputs block
 * anyway, because their absence cannot be proven without the details. When
 * suppressions are honored and may apply (`suppressionsMayApply`) they cannot be
 * applied without the rows either, so the post-suppression severity is unknown
 * and a raw severity match is recorded as unverified. The caller decides
 * `suppressionsMayApply`: per image from the stored suppressions on the truncated
 * path, and plain `honorSuppressions` when the read itself failed. The cause is carried in
 * `unverified` so the block log can name it.
 */
function aggregateFallback(
    inputs: PolicyRiskInputs,
    rawSeverity: VulnSeverity,
    scan: PreflightScan,
    failClosedCause: string | null,
    suppressionsMayApply: boolean,
): ImageRiskEvaluation {
    const reasons: PolicyBlockReason[] = [];
    const unverified: PolicyBlockReason[] = [];
    if (inputs.blockOnSeverity && isSeverityAtLeast(rawSeverity, inputs.maxSeverity)) {
        reasons.push('severity');
        if (failClosedCause && suppressionsMayApply) unverified.push('severity');
    }
    if (failClosedCause && inputs.blockOnKev) unverified.push('kev');
    if (failClosedCause && inputs.blockOnFixable) unverified.push('fixable');
    reasons.push(...unverified.filter((r) => r !== 'severity'));
    return {
        reasons,
        severity: rawSeverity,
        criticalCount: scan.critical_count,
        highCount: scan.high_count,
        kevCount: 0,
        fixableCount: 0,
        suppressedCves: [],
        rawWouldBlock: reasons.length > 0,
        ...(failClosedCause && unverified.length > 0 ? { unverified: { reasons: unverified, cause: failClosedCause } } : {}),
    };
}

/**
 * Resolve which of a policy's risk inputs (severity, KEV, fixability) an image
 * matches. A severity-only policy that is not honoring suppressions keeps the
 * cheap aggregate path (historical behavior). Any KEV/fixable input, or honoring
 * suppressions, requires the per-finding detail rows: KEV/fixability cannot be
 * read from the aggregate counts, so the details are loaded regardless of the
 * honor flag. KEV/fixable are evaluated over the non-suppressed set only.
 */
function evaluateImageRisk(
    scan: PreflightScan,
    imageRef: string,
    policy: ScanPolicy,
    honorSuppressions: boolean,
): ImageRiskEvaluation {
    const inputs = policyInputs(policy);
    const rawSeverity = scan.highest_severity ?? 'UNKNOWN';
    const needsDetails = inputs.blockOnKev || inputs.blockOnFixable || honorSuppressions;
    if (!needsDetails) {
        return aggregateFallback(inputs, rawSeverity, scan, null, false);
    }

    const db = DatabaseService.getInstance();
    let findings: VulnerabilityDetail[];
    let suppressions;
    try {
        findings = db.getAllVulnerabilityDetails(scan.id);
        suppressions = db.getCveSuppressions();
    } catch (err) {
        // Detail read failed: severity still gates from the aggregate (without
        // applying suppressions), but KEV/fixability are unknowable. Fail closed
        // on them, consistent with the truncated-details path below: a policy
        // that explicitly opted into a KEV/fixable gate must not silently degrade
        // to "allow" on a transient read error. The admin bypass path stays
        // available.
        console.error('[Policy] Detail read failed for %s; gating severity on aggregate, failing closed on KEV/fixable:', sanitizeForLog(imageRef), sanitizeForLog(getErrorMessage(err, 'db read failed')));
        return {
            ...aggregateFallback(inputs, rawSeverity, scan, EVIDENCE_READ_FAILED, honorSuppressions),
            partialEvidenceReason: partialFindingsReason('The scan findings could not be read', inputs),
        };
    }

    // The stored detail rows must reproduce the scan's full finding set before
    // KEV/fixability can be trusted. A cache-hit preflight scan keeps the
    // complete aggregate counts but copies only the first N detail rows. When the
    // counts disagree, gate severity on the raw aggregate (suppressions cannot be
    // applied to a partial set) and fail closed on any KEV/fixable input: absence
    // of a known-exploited or fixable finding cannot be proven from a truncated
    // set, so the unverifiable finding is treated as risky.
    if (findings.length !== scan.total_vulnerabilities) {
        if (scan.total_vulnerabilities > 0) {
            console.warn(
                '[Policy] Scan %d detail rows (%d) do not match its total (%d); gating severity on raw scan, failing closed on KEV/fixable',
                scan.id, findings.length, scan.total_vulnerabilities,
            );
        }
        // A match on the raw severity stands verified unless suppressions are
        // honored and some stored row could dismiss a finding on this image (a row
        // for another image, an expired one, or one with a non-dismissing status
        // never can). The missing detail rows might hold the findings that row
        // covers; with no such row the raw severity equals the post-suppression one.
        return {
            ...aggregateFallback(
                inputs, rawSeverity, scan,
                detailRowsTruncated(findings.length, scan.total_vulnerabilities),
                honorSuppressions && suppressions.some((s) => mayDismissOnImage(s, imageRef)),
            ),
            partialEvidenceReason: partialFindingsReason('The stored findings do not cover every vulnerability in this scan', inputs),
        };
    }

    // KEV membership is the same for the full set and the non-suppressed subset,
    // so resolve intel once over every CVE and reuse it for both the effective
    // decision and the suppression-pass check below.
    const intel = inputs.blockOnKev ? db.getCveIntel(findings.map((f) => f.vulnerability_id)) : null;
    const isKev = (cveId: string): boolean => intel?.get(cveId)?.kev === true;

    const suppressedCves = new Set<string>();
    let evalSet: VulnerabilityDetail[];
    if (honorSuppressions) {
        evalSet = [];
        for (const f of applySuppressions(findings, imageRef, suppressions)) {
            if (f.suppressed) { suppressedCves.add(f.vulnerability_id); continue; }
            evalSet.push(f);
        }
    } else {
        evalSet = findings;
    }

    const outcome = evaluatePolicyRisk(evalSet, isKev, inputs);
    // When honoring suppressions, "would have blocked on the raw set" detects a
    // pass that only succeeded because an accepted CVE was filtered out.
    const rawWouldBlock = honorSuppressions
        ? evaluatePolicyRisk(findings, isKev, inputs).reasons.length > 0
        : outcome.reasons.length > 0;
    return {
        reasons: outcome.reasons,
        severity: outcome.highestSeverity,
        criticalCount: outcome.criticalCount,
        highCount: outcome.highCount,
        kevCount: outcome.kevCount,
        fixableCount: outcome.fixableCount,
        suppressedCves: [...suppressedCves],
        rawWouldBlock,
    };
}

/**
 * The evidence half of an audit summary: the outcome, each record that was not
 * `current`, and the configured rules that acted. Empty for a clean pass,
 * so a row that has nothing to say about evidence reads exactly as it did before.
 *
 * Targets are image references taken from a compose file, so they are stripped of
 * control characters and credentials before they reach a row an operator reads.
 */
function describeEvidenceForAudit(evidence: EvidenceGateDecision | undefined): string {
    if (!evidence || isCleanEvidenceDecision(evidence)) return '';
    // Targets are compose-file text. Beyond control characters and credentials,
    // the characters this summary uses as delimiters are replaced so a hostile
    // `image:` value cannot forge a field, and the length is capped so one cannot
    // bloat the row.
    const clean = (value: string): string =>
        redactSensitiveText(sanitizeForLog(value)).replace(/[\s,=[\]]/g, '_').slice(0, 200);
    const unproven = evidence.records
        .filter((r) => r.state !== 'current')
        .map((r) => `${r.source}:${r.state}:${clean(r.target)}`);
    const rules = evidence.applications.map((a) => `${a.rule}${a.target ? `@${clean(a.target)}` : ''}`);
    return ` evidence_outcome=${evidence.outcome} unproven=[${unproven.join(',')}] rules=[${rules.join(',')}]`;
}

/**
 * Record an allowed decision whose evidence was not a clean pass.
 *
 * The gate's result is returned to its caller, but a caller that proceeds has no
 * reason to keep it, and the unattended ones (scheduler, auto-update, webhooks,
 * Git sources, rollback) have nowhere to put it. Without this row an operation
 * allowed on a failed scan or a missing scanner is indistinguishable afterwards
 * from one allowed on current, clean evidence. It names the actor and trigger
 * (the audit entry's username, method and path), the policy, and what the
 * evidence was and which configured rules acted, if any. It records the gate's
 * decision, written when the gate allows, not that the operation then completed.
 * Written here, once, so no caller has to remember to.
 *
 * A bypassed decision is not written again: its `policy.bypass` row already
 * names the exception and carries the same evidence clause.
 */
function recordAllowedEvidenceAudit(
    result: PolicyEnforcementResult,
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): void {
    if (opts.recordAllowedEvidence === false || result.bypassed) return;
    const { evidence, policy } = result;
    if (!result.ok || !policy) return;
    let summary = `policy.evidence_allowed stack="${stackName}" policy="${policy.name}"`;
    try {
        const clause = describeEvidenceForAudit(evidence);
        if (clause === '') return;
        summary += clause;
        DatabaseService.getInstance().insertAuditLog({
            timestamp: Date.now(),
            username: opts.actor,
            method: opts.auditMethod ?? 'POST',
            path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
            status_code: 200,
            node_id: nodeId,
            ip_address: opts.ip ?? '',
            summary,
        });
    } catch (err) {
        // The summary is logged whole: if the row is lost, this line is the only
        // account of which unattended operation proceeded on what.
        console.error('[Policy] Failed to record evidence decision audit entry (%s):', sanitizeForLog(summary), err);
    }
}

/**
 * The single exit every public entry point funnels an allowed decision through:
 * the durable audit row, then the caller's in-request callback.
 */
function retainAllowedDecision(
    result: PolicyEnforcementResult,
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): PolicyEnforcementResult {
    recordAllowedEvidenceAudit(result, stackName, nodeId, opts);
    const { policyEvidence } = allowedPolicyEvidence(result);
    if (policyEvidence) {
        // The decision is already durable and the gate allowed: a callback that
        // throws must not turn that into a refused operation.
        try {
            opts.onAllowed?.(policyEvidence);
        } catch (err) {
            console.error('[Policy] onAllowed callback failed:', err);
        }
    }
    return result;
}

/**
 * Record an authorized bypass.
 *
 * Shared by every refusal this evaluator can return, because a bypass is the
 * same security-relevant event whichever branch refused: an admin chose to
 * proceed past a gate. Writing this inline at one branch and not another is how
 * the scanner-unavailable bypass came to leave no trace at all.
 */
function recordBypassAudit(
    stackName: string,
    nodeId: number,
    policy: ScanPolicy,
    images: string[],
    opts: PolicyEnforcementOptions,
    evidence?: EvidenceGateDecision,
): void {
    try {
        DatabaseService.getInstance().insertAuditLog({
            timestamp: Date.now(),
            username: opts.actor,
            method: opts.auditMethod ?? 'POST',
            path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
            status_code: 200,
            node_id: nodeId,
            ip_address: opts.ip ?? '',
            summary: `policy.bypass stack="${stackName}" policy="${policy.name}" violations=${images.length} images=[${images.join(',')}]${describeEvidenceForAudit(evidence)}`,
        });
    } catch (err) {
        console.error('[Policy] Failed to record bypass audit entry:', err);
    }
}

/**
 * A deploy that would have been blocked on raw severity but proceeded because
 * suppressions dropped every image below the threshold is a security-relevant
 * event: record it so the suppression-driven pass is traceable in the audit log.
 */
function recordSuppressionPassAudit(
    stackName: string,
    nodeId: number,
    policy: ScanPolicy,
    passes: SuppressionPass[],
    opts: PolicyEnforcementOptions,
): void {
    const cves = [...new Set(passes.flatMap((p) => p.cves))];
    try {
        DatabaseService.getInstance().insertAuditLog({
            timestamp: Date.now(),
            username: opts.actor,
            method: opts.auditMethod ?? 'POST',
            path: opts.auditPath ?? `/api/stacks/${stackName}/deploy`,
            status_code: 200,
            node_id: nodeId,
            ip_address: opts.ip ?? '',
            summary: `policy.suppression_pass stack="${stackName}" policy="${policy.name}" images=[${passes.map((p) => p.imageRef).join(',')}] cves=[${cves.join(',')}]`,
        });
    } catch (err) {
        console.error('[Policy] Failed to record suppression-pass audit entry:', err);
    }
    console.warn(
        '[Policy] Deploy for "%s" allowed by suppressions: %d image(s) would have matched %s (policy "%s")',
        sanitizeForLog(stackName), passes.length, describePolicyInputs(policyInputs(policy)), sanitizeForLog(policy.name),
    );
}

export async function enforcePolicyPreDeploy(
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): Promise<PolicyEnforcementResult> {
    return retainAllowedDecision(await evaluatePreDeploy(stackName, nodeId, opts), stackName, nodeId, opts);
}

async function evaluatePreDeploy(
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): Promise<PolicyEnforcementResult> {
    const db = DatabaseService.getInstance();
    const policy = db.getMatchingPolicy(nodeId, stackName, FleetSyncService.getSelfIdentity());

    if (!policy || !policy.enabled || !policy.block_on_deploy) {
        return { ok: true, bypassed: false, policy: policy ?? undefined, violations: [] };
    }

    const svc = TrivyService.getInstance();
    if (!svc.isTrivyAvailable()) {
        return decideScannerUnavailable(policy, loadGateSettings().evidencePolicy, nodeId, stackName, opts);
    }

    let imageRefs: string[] = [];
    try {
        imageRefs = await ComposeService.getInstance(nodeId).listStackImages(
            stackName,
            opts.composeInvocation ?? null,
        );
    } catch (err) {
        const message = getErrorMessage(err, 'compose parse failed');
        console.error('[Policy] listStackImages failed for %s:', sanitizeForLog(stackName), sanitizeForLog(message));
        return {
            ok: false,
            bypassed: false,
            policy,
            violations: [{
                imageRef: '(compose parse error)',
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                kevCount: 0,
                fixableCount: 0,
                reasons: [],
                scanId: 0,
                error: `Compose file could not be parsed: ${message}`,
            }],
        };
    }

    return evaluateImageRefs(stackName, nodeId, imageRefs, opts, policy, false, await candidateModelFor(nodeId, stackName, opts));
}

/**
 * The per-service model the candidate plan reads, or null when this gate call is
 * not in a pulling mode.
 *
 * A render failure is reported as an unrenderable model rather than thrown. A
 * registry update then resolves every reference as a candidate, the stricter
 * reading, because its own `compose pull` is what could fetch one. A plain `up`
 * cannot attribute any reference to a service, so it evaluates the installed
 * image and keeps `up --pull never` instead.
 */
async function candidateModelFor(
    nodeId: number,
    stackName: string,
    opts: PolicyEnforcementOptions,
): Promise<Awaited<ReturnType<typeof buildEffectiveServiceModel>> | null> {
    if ((opts.imageSource ?? 'installed') === 'installed') return null;
    return buildEffectiveServiceModel(nodeId, stackName);
}

export async function enforcePolicyForImageRefs(
    stackName: string,
    nodeId: number,
    imageRefs: string[],
    opts: PolicyEnforcementOptions,
    matchedPolicy?: ScanPolicy,
    failClosedInvalidRefs = false,
    candidateModel: Awaited<ReturnType<typeof buildEffectiveServiceModel>> | null = null,
): Promise<PolicyEnforcementResult> {
    const result = await evaluateImageRefs(
        stackName, nodeId, imageRefs, opts, matchedPolicy, failClosedInvalidRefs, candidateModel,
    );
    return retainAllowedDecision(result, stackName, nodeId, opts);
}

/**
 * The evaluator both public entry points and the candidate path share. It does
 * not write the allowed-evidence audit row: a candidate is not an operation, its
 * decision is persisted with the generation it describes, and a deploy-shaped
 * row for it would attribute an acceptance to a deploy that never happened.
 */
async function evaluateImageRefs(
    stackName: string,
    nodeId: number,
    imageRefs: string[],
    opts: PolicyEnforcementOptions,
    matchedPolicy?: ScanPolicy,
    failClosedInvalidRefs = false,
    candidateModel: Awaited<ReturnType<typeof buildEffectiveServiceModel>> | null = null,
): Promise<PolicyEnforcementResult> {
    const db = DatabaseService.getInstance();
    const policy = matchedPolicy ?? db.getMatchingPolicy(nodeId, stackName, FleetSyncService.getSelfIdentity());

    if (!policy || !policy.enabled || !policy.block_on_deploy) {
        return { ok: true, bypassed: false, policy: policy ?? undefined, violations: [] };
    }

    const svc = TrivyService.getInstance();
    if (!svc.isTrivyAvailable()) {
        return decideScannerUnavailable(policy, loadGateSettings().evidencePolicy, nodeId, stackName, opts);
    }

    const { evidencePolicy, honorSuppressions } = loadGateSettings();

    const debug = isDebugEnabled();
    if (debug) {
        console.log(
            '[Policy:debug] Evaluating "%s" against policy "%s" (inputs=%s, images=%d, honorSuppressions=%s)',
            sanitizeForLog(stackName), sanitizeForLog(policy.name), describePolicyInputs(policyInputs(policy)), imageRefs.length, honorSuppressions,
        );
    }

    const violations: PolicyViolation[] = [];
    // Log-only side table: violations with unverified evidence (KEV/fixable
    // reasons assumed, or a severity match that honored suppressions could not
    // be applied to), kept off PolicyViolation so the API and the user-facing
    // block messages are unchanged.
    const unverifiedByViolation = new Map<PolicyViolation, NonNullable<ImageRiskEvaluation['unverified']>>();
    const suppressionPasses: SuppressionPass[] = [];
    const evidenceRecords: SecurityEvidenceRecord[] = [];
    const evidenceApplications: EvidenceRuleApplication[] = [];
    const imageSource = opts.imageSource ?? 'installed';
    // Resolved once, before the loop: one registry probe per candidate and one
    // platform read per gate call, not one per image.
    const planned = imageSource === 'installed'
        ? null
        : await planCandidates(nodeId, imageRefs, imageSource, candidateModel);
    const candidatePlan = planned?.plan ?? null;
    const plannedPullServices = planned && planned.pullServices.size > 0
        ? [...planned.pullServices]
        : undefined;
    const noPullOnUp = planned?.noPullOnUp === true;
    const evaluatedCandidates: EvaluatedCandidate[] = [];
    // A ref shared by services with different platform overrides has one plan
    // entry per platform Compose will resolve. Invalid references are recorded
    // before the scan loop, as before; every other target pairs a ref with the
    // one image (or the installed image) that service will run.
    const targets: Array<{ imageRef: string; planned: CandidatePlanEntry | null }> = [];
    for (const imageRef of imageRefs) {
        if (!validateImageRef(imageRef)) {
            // A reference that cannot be parsed is not an image, so the scanner
            // never gets a chance to produce an answer. Recorded as
            // `not_evaluated` so the decision record shows a gap rather than a
            // silent omission; whether it blocks stays a caller decision, not
            // this branch's.
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: 'not_evaluated',
                target: imageRef,
                collectedAt: null,
                reason: 'Not a valid image reference, so no scan was attempted',
            });
            if (failClosedInvalidRefs) {
                violations.push(unavailableViolation(imageRef, 'Invalid image reference; the image could not be scanned'));
            }
            continue;
        }
        const entries = candidatePlan?.get(imageRef);
        if (entries && entries.length > 0) {
            for (const plannedEntry of entries) targets.push({ imageRef, planned: plannedEntry });
        } else {
            targets.push({ imageRef, planned: null });
        }
    }
    for (const { imageRef, planned } of targets) {
        let scan: VulnerabilityScan;
        if (planned?.kind === 'unresolved') {
            // The image this operation would pull could not be resolved, so the
            // installed image is NOT scanned in its place: it is not what will
            // run, and a clean result about it would be a false assurance.
            const { state, reason, failureClass } = planned.resolution;
            const unresolvedPlatform = planned.platform ?? null;
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state,
                target: imageRef,
                collectedAt: null,
                subject: 'candidate',
                ...(unresolvedPlatform ? { platform: unresolvedPlatform } : {}),
                reason,
            });
            const rule = failureRule(evidencePolicy, opts);
            evidenceApplications.push({
                source: 'vulnerability_scan',
                state,
                outcome: rule.outcome,
                rule: ruleClause(rule.key, rule.outcome),
                target: imageRef,
                ...(unresolvedPlatform ? { platform: unresolvedPlatform } : {}),
            });
            if (rule.outcome === 'warn' && opts.recordAllowedEvidence !== false) {
                notifyEvidenceWarningOnce(
                    nodeId, stackName, rule.key,
                    `the image ${imageRef} would install could not be resolved (${failureClass})`,
                );
            }
            if (rule.outcome === 'block') {
                violations.push(unavailableViolation(
                    imageRef,
                    `The image this operation would pull could not be resolved: ${reason}`,
                    unresolvedPlatform,
                ));
            }
            continue;
        }
        const candidateEntry = planned?.kind === 'candidate' ? planned : null;
        const candidate = candidateEntry?.resolution ?? null;
        const subject: 'installed' | 'candidate' = candidate || opts.pulledCandidate === true ? 'candidate' : 'installed';
        try {
            scan = await svc.scanImagePreflight(
                imageRef,
                nodeId,
                stackName,
                candidate
                    ? {
                        scanRef: candidate.scanRef,
                        digest: candidate.indexDigest,
                        // The scan row is keyed by the persisted digest, which is
                        // the index for a multi-arch tag. A cached row for the
                        // same index can belong to another platform child, so a
                        // qualified child is always scanned fresh. An exact
                        // manifest is its own digest and keeps cache reuse.
                        ...(candidate.qualification === 'qualified' ? { useCache: false } : {}),
                    }
                    : undefined,
            );
        } catch (err) {
            const message = getErrorMessage(err, 'pre-flight scan failed');
            console.error(`[Policy] scanImagePreflight failed for ${imageRef}:`, message);
            const classification = classifyScanEvidence({
                now: Date.now(),
                collectedAt: null,
                freshnessThresholdMs: null,
                failed: true,
                failureReason: `Pre-flight scan failed: ${message}`,
            });
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: classification.state,
                target: imageRef,
                collectedAt: null,
                // The resolver already named the exact image, so a failed scan
                // still says which one it could not prove.
                ...(candidate
                    ? {
                        subject: 'candidate' as const,
                        digest: candidate.indexDigest,
                        platformDigest: candidate.platformDigest,
                        platform: candidate.platform,
                    }
                    : { subject }),
                reason: classification.reason,
            });
            const rule = failureRule(evidencePolicy, opts);
            evidenceApplications.push({
                source: 'vulnerability_scan',
                state: classification.state,
                outcome: rule.outcome,
                rule: ruleClause(rule.key, rule.outcome),
                target: imageRef,
                ...(candidate ? { platform: candidate.platform } : {}),
            });
            // allow and warn both let the deploy through; warn additionally says
            // so out loud, which is the only thing distinguishing it from allow
            // at the call site. Neither is silent.
            if (rule.outcome === 'warn' && opts.recordAllowedEvidence !== false) {
                notifyEvidenceWarningOnce(
                    nodeId, stackName, rule.key,
                    `the scan of ${imageRef} did not complete`,
                );
            }
            if (rule.outcome !== 'block') {
                continue;
            }
            violations.push(unavailableViolation(
                imageRef,
                `Pre-flight scan failed: ${message}`,
                candidate?.platform ?? null,
            ));
            continue;
        }

        // No freshness bound is passed. This path scans on demand (reusing a
        // cached row only inside the scanner's own cache window), so the
        // evidence it holds is fresh by construction and can never be `stale`.
        // The `stale` state and the classifier's bound exist for the paths that
        // read stored evidence without re-scanning; they arrive with the
        // cached-acceptance work.
        const scanEvidence = classifyScanEvidence({
            now: Date.now(),
            collectedAt: scan.scanned_at,
            freshnessThresholdMs: null,
        });
        const candidateFields: Pick<SecurityEvidenceRecord, 'subject' | 'platformDigest' | 'platform' | 'databaseUpdatedAt'> = candidate
            ? {
                subject: 'candidate',
                platformDigest: candidate.platformDigest,
                platform: candidate.platform,
                databaseUpdatedAt: scan.vuln_db_updated_at ?? null,
            }
            : { subject };
        if (candidate) {
            evaluatedCandidates.push({
                ref: imageRef,
                indexDigest: candidate.indexDigest,
                platformDigest: candidate.platformDigest,
                ...(candidateEntry && candidateEntry.services.length > 0 ? { services: candidateEntry.services } : {}),
            });
        }
        evidenceRecords.push({
            source: 'vulnerability_scan',
            state: scanEvidence.state,
            target: imageRef,
            collectedAt: scan.scanned_at,
            digest: scan.image_digest ?? null,
            ...candidateFields,
            ...(scanEvidence.reason ? { reason: scanEvidence.reason } : {}),
        });
        try {
            const evaluated = evaluateImageRisk(scan, imageRef, policy, honorSuppressions);
            if (debug) {
                console.log(
                    '[Policy:debug] %s scanned: severity=%s kev=%d fixable=%d matched=[%s] unverified=[%s]',
                    sanitizeForLog(imageRef), evaluated.severity, evaluated.kevCount, evaluated.fixableCount,
                    evaluated.reasons.filter((r) => !evaluated.unverified?.reasons.includes(r)).join(','),
                    evaluated.unverified?.reasons.join(',') ?? '',
                );
            }
            // The same image carries two records: the scan's own freshness state
            // above, and whether its finding set was complete enough to read
            // KEV and fixability from. A clean result under partial evidence is
            // not a clean result.
            if (evaluated.partialEvidenceReason) {
                evidenceRecords.push({
                    source: 'vulnerability_scan',
                    state: 'partial',
                    target: imageRef,
                    collectedAt: scan.scanned_at,
                    digest: scan.image_digest ?? null,
                    ...candidateFields,
                    reason: evaluated.partialEvidenceReason,
                });
                // Deliberately a record and not an application. `outcome` reports
                // what the availability POLICY decided, and the policy has no
                // setting for partial evidence: the gate fails closed on the
                // known-exploited and fixability inputs the policy enables, which
                // is why this can block while the outcome reads `allow`. Recording it as an
                // `allow` application would be worse, by implying a policy
                // permitted something no policy governs. Consumers explain the
                // block from the records, which carry the reason.
            }
            if (evaluated.reasons.length > 0) {
                const violation: PolicyViolation = {
                    imageRef,
                    severity: evaluated.severity,
                    criticalCount: evaluated.criticalCount,
                    highCount: evaluated.highCount,
                    kevCount: evaluated.kevCount,
                    fixableCount: evaluated.fixableCount,
                    reasons: evaluated.reasons,
                    scanId: scan.id,
                    // A ref shared by services with different overrides has one
                    // row per platform; the row carries its own variant so the
                    // dialog can pair it with the evidence for that variant.
                    ...(candidate ? { platform: candidate.platform } : {}),
                };
                violations.push(violation);
                if (evaluated.unverified) unverifiedByViolation.set(violation, evaluated.unverified);
            } else if (
                honorSuppressions &&
                evaluated.suppressedCves.length > 0 &&
                evaluated.rawWouldBlock
            ) {
                suppressionPasses.push({ imageRef, cves: evaluated.suppressedCves });
            }
        } catch (err) {
            const message = getErrorMessage(err, 'policy evaluation failed');
            console.error(`[Policy] policy evaluation failed for ${imageRef}:`, message);
            // Recorded as evidence as well as a violation. The scan is current,
            // but the decision it was supposed to support is not, and a consumer
            // that reads only the evidence records (the candidate path does) must
            // still see this image as unproven. Without this record an evaluation
            // failure looked identical to a clean pass.
            evidenceRecords.push({
                source: 'vulnerability_scan',
                state: 'failed',
                target: imageRef,
                collectedAt: scan.scanned_at,
                digest: scan.image_digest ?? null,
                ...candidateFields,
                reason: `Policy evaluation failed: ${message}`,
            });
            violations.push({
                imageRef,
                severity: 'UNKNOWN',
                criticalCount: 0,
                highCount: 0,
                kevCount: 0,
                fixableCount: 0,
                reasons: [],
                // The scan completed; only evaluation failed, so the real scan
                // id is kept (the other failure sites have no scan and use 0).
                scanId: scan.id,
                ...(candidate ? { platform: candidate.platform } : {}),
                error: `Policy evaluation failed: ${message}`,
            });
        }
    }

    // Built once, before any return below this point, so every exit carries the
    // same account of what the evidence said. A decision with no violation can
    // still have been made on `unavailable` evidence, and that is exactly the
    // case an operator cannot otherwise see.
    //
    // No notification here. Every rule that can produce `warn` already notified
    // at the point it fired, keyed by (node, stack, rule), and one event must
    // not alert twice under two different keys.
    //
    // Two earlier returns are deliberately not covered: the no-matching-policy
    // case required no evidence, and the compose-parse failure never reached the
    // point where an image could be examined (its violation carries its own
    // `(compose parse error)` explanation).
    const evidence = decideEvidenceGate(evidenceRecords, evidenceApplications);

    if (violations.length === 0) {
        if (suppressionPasses.length > 0 && opts.recordAllowedEvidence !== false) {
            recordSuppressionPassAudit(stackName, nodeId, policy, suppressionPasses, opts);
        }
        return {
            ok: true, bypassed: false, policy, violations: [], evidence,
            ...(evaluatedCandidates.length > 0 ? { evaluatedCandidates } : {}),
            ...(plannedPullServices ? { pullServices: plannedPullServices } : {}),
            ...(noPullOnUp ? { noPullOnUp: true } : {}),
        };
    }

    if (opts.bypass) {
        recordBypassAudit(stackName, nodeId, policy, violations.map((v) => v.imageRef), opts, evidence);
        if (debug) {
            console.log(
                '[Policy:debug] Bypass for "%s" (%d violation(s))',
                sanitizeForLog(stackName), violations.length,
            );
        }
        return {
            ok: true, bypassed: true, policy, violations, evidence,
            ...(evaluatedCandidates.length > 0 ? { evaluatedCandidates } : {}),
            ...(plannedPullServices ? { pullServices: plannedPullServices } : {}),
            ...(noPullOnUp ? { noPullOnUp: true } : {}),
        };
    }

    // Three causes, each logged as what it is. `error`: the image could not be
    // scanned or evaluated. `unverified`: KEV/fixable reasons were assumed, or a
    // severity match could not be checked against honored suppressions, because
    // the detail rows could not be trusted (a severity match on the same image is
    // named too, as unverified when it could not be checked against honored
    // suppressions). Everything else matched a policy input.
    const unevaluated = violations.filter((v) => v.error);
    const unverified = violations.filter((v) => !v.error && unverifiedByViolation.has(v));
    const matched = violations.filter((v) => !v.error && !unverifiedByViolation.has(v));
    if (matched.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) matched %s (policy "%s")',
            sanitizeForLog(stackName), matched.length, describePolicyInputs(policyInputs(policy)), sanitizeForLog(policy.name),
        );
    }
    if (unverified.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) had evidence that could not be verified (policy "%s"): %s',
            sanitizeForLog(stackName), unverified.length, sanitizeForLog(policy.name),
            unverified.map((v) => `${logEntry(v.imageRef)}: ${describeUnverified(v, unverifiedByViolation.get(v)!)}`).join('; '),
        );
    }
    if (unevaluated.length > 0) {
        console.warn(
            '[Policy] Blocked deploy for "%s": %d image(s) could not be evaluated (policy "%s"): %s',
            sanitizeForLog(stackName), unevaluated.length, sanitizeForLog(policy.name),
            unevaluated.map((v) => `${logEntry(v.imageRef)}: ${logEntry(v.error ?? '')}`).join('; '),
        );
    }
    return {
        ok: false, bypassed: false, policy, violations, evidence,
        ...(evaluatedCandidates.length > 0 ? { evaluatedCandidates } : {}),
        ...(plannedPullServices ? { pullServices: plannedPullServices } : {}),
        ...(noPullOnUp ? { noPullOnUp: true } : {}),
    };
}

/**
 * Decide what a hub-driven unattended update means for a remote node whose build
 * evaluates the installed image instead of the image the update would pull.
 *
 * Only a matching enabled blocking policy makes this a decision at all: with no
 * policy there is nothing to enforce, and the update proceeds exactly as before.
 * The record says `unsupported`, which is the truth about that node (it cannot
 * evaluate a candidate), and the Candidate not evaluated rule says what to do
 * about it. Nothing is probed here; the caller has already established that the
 * node does not advertise the capability.
 */
export function evaluateRemoteCandidateSupport(
    stackName: string,
    nodeId: number,
    opts: PolicyEnforcementOptions,
): PolicyEnforcementResult {
    const db = DatabaseService.getInstance();
    const policy = db.getMatchingPolicy(nodeId, stackName, FleetSyncService.getSelfIdentity());
    if (!policy || !policy.enabled || !policy.block_on_deploy) {
        return { ok: true, bypassed: false, policy: policy ?? undefined, violations: [] };
    }
    const { evidencePolicy } = loadGateSettings();
    const outcome = evidencePolicy.candidateUnproven;
    const reason = 'This node\'s version checks the image already installed, not the image this update would pull';
    const decision = decideEvidenceGate(
        [{
            source: 'vulnerability_scan',
            state: 'unsupported',
            target: NODE_WIDE_EVIDENCE_TARGET,
            collectedAt: null,
            subject: 'candidate',
            reason,
        }],
        [{
            source: 'vulnerability_scan',
            state: 'unsupported',
            outcome,
            rule: ruleClause('security_candidate_unproven', outcome),
        }],
    );
    if (outcome === 'warn' && opts.recordAllowedEvidence !== false) {
        notifyEvidenceWarningOnce(
            nodeId, stackName, 'security_candidate_unproven',
            'this node checks the image already installed, not the image an update would pull',
        );
    }
    const result: PolicyEnforcementResult = outcome === 'block'
        ? { ok: false, bypassed: false, policy, violations: [unavailableViolation('(node)', reason)], evidence: decision }
        : { ok: true, bypassed: false, policy, violations: [], evidence: decision };
    return retainAllowedDecision(result, stackName, nodeId, opts);
}

/**
 * Tri-state candidate evaluation for GitOps source acceptance, built on the
 * same evaluator the deploy-time gate uses, with the candidate's own image
 * refs supplied directly rather than read from disk. Has side effects:
 * writes a policy.bypass/policy.suppression_pass audit row when applicable,
 * and may dispatch the once-per-hour Trivy-missing operator notification.
 */
export async function evaluateCandidatePolicy(
    stackName: string,
    nodeId: number,
    imageRefs: string[],
    opts: PolicyEnforcementOptions,
): Promise<CandidatePolicyEvaluation> {
    const result = await evaluateImageRefs(stackName, nodeId, imageRefs, {
        ...opts,
        // The candidate is a registry image the source will pull, and nobody is
        // at the keyboard to answer for it, so it is resolved and scanned by
        // digest and held under the Candidate not evaluated rule when unproven.
        imageSource: 'registry',
        unattended: true,
        // Undefaulted, these attribute the audit row to a deploy path
        // (the evaluator's own default), which never happened
        // for a pre-acceptance candidate.
        auditMethod: opts.auditMethod ?? 'POST',
        auditPath: opts.auditPath ?? `/api/stacks/${stackName}/git-source/candidate`,
        // The deploy gate silently skips an unscannable ref (fail-open,
        // since it must never block an operator's deploy on its own
        // inability to evaluate). Candidate evaluation is the opposite: an
        // unscannable ref must surface as evidence, not vanish, so it can be
        // told apart from a genuinely clean scan below.
    }, undefined, true);

    // A violation with no `error` is a genuine scanned policy match; one with
    // `error` set is an invalid ref, a scan failure, or an evaluation failure,
    // which is evidence Sencho could not prove either way rather than a proven
    // violation. Only a genuine match is reported as `blocked`; everything else
    // is `unavailable` so it cannot read as a refusal on the merits.
    const hasGenuineViolation = result.violations.some((v) => !v.error);

    if (opts.bypass && (result.bypassed || result.trivyMissing || hasGenuineViolation)) {
        return { status: 'allowed', policy: result.policy, evidence: result.evidence };
    }
    if (hasGenuineViolation) {
        return { status: 'blocked', policy: result.policy, evidence: result.evidence, violations: result.violations };
    }

    // Anything the gate could not establish as `current` is unproven, and this
    // path applies its OWN rule to it rather than inheriting the deploy gate's.
    // That separation is the point: a setting an operator relaxes to get past a
    // scanner outage at the keyboard must not become standing authority for an
    // unattended automation to accept a candidate nothing proved safe. The
    // default holds, which is also what this path did before it was
    // configurable.
    // Unproven is read from BOTH the evidence records and the violations, not
    // from the records alone. A violation carrying `error` is by construction a
    // case the gate could not evaluate, and deriving this only from records made
    // an evaluation failure look clean: the scan itself is `current`, so nothing
    // in the records said otherwise. Two independent signals, so a future record
    // that is missed cannot silently become authority to accept.
    const unprovenTargets = new Set<string>();
    for (const r of result.evidence?.records ?? []) {
        // `partial` is deliberately not counted here. It says the per-finding
        // detail rows were truncated, which only reaches a verdict that reads
        // known-exploited or fixability out of them. When the policy has either
        // input, the evaluator has already turned the truncation into a genuine
        // violation, so the candidate is refused above on the merits and this
        // record adds nothing. When it has neither, the only input is severity,
        // which comes from the scan's complete aggregate: a truncated read can
        // only withhold the suppressions that would have *removed* a finding, so
        // it cannot turn an allowed image into a blocked one. Holding on it there
        // would refuse a candidate the policy had already decided about.
        if (r.state !== 'current' && r.state !== 'partial') unprovenTargets.add(r.target);
    }
    for (const v of result.violations) {
        if (v.error) unprovenTargets.add(v.imageRef);
    }
    const unproven = [...unprovenTargets];
    if (unproven.length > 0) {
        const { candidateUnproven } = loadGateSettings().evidencePolicy;
        // The rule is recorded on the decision itself. An acceptance on unproven
        // evidence that left no trace of which setting permitted it would
        // contradict the whole point of resolving the rule into the record, and
        // this is the one path where "allowed" and "proven clean" look alike
        // downstream.
        const evidence = withCandidateRuleApplied(result.evidence, candidateUnproven, unproven);
        if (candidateUnproven === 'allow') {
            return { status: 'allowed', policy: result.policy, evidence };
        }
        if (candidateUnproven === 'warn') {
            notifyEvidenceWarningOnce(
                nodeId, stackName, 'security_candidate_unproven',
                `a candidate image could not be fully evaluated (${unproven.join(", ")})`,
            );
            return { status: 'allowed', policy: result.policy, evidence };
        }
        return {
            status: 'unavailable',
            policy: result.policy,
            evidence,
            reason: 'Candidate could not be fully evaluated',
        };
    }

    return { status: 'allowed', policy: result.policy, evidence: result.evidence };
}

/**
 * Attach the candidate rule to a decision.
 *
 * The shared evaluator does not know about `candidateUnproven`, so it never
 * records an application for it, whether or not the decision already carries the
 * deploy gate's. This adds one per unproven target either way: without it, an
 * acceptance on unproven evidence is recorded with no rule that permitted it,
 * and is indistinguishable from a clean one.
 */
function withCandidateRuleApplied(
    decision: EvidenceGateDecision | undefined,
    outcome: EvidenceAvailabilityOutcome,
    targets: string[],
): EvidenceGateDecision | undefined {
    if (!decision) return decision;
    // One application per unproven target, even when the evaluator already
    // recorded an application for it. Those name the deploy-gate rule that fired
    // (a scan failure, say); this one names the candidate rule that decided what
    // to do about it, and the two are different facts. The source and state are
    // reused from whatever already described this target, so the entry does not
    // restate it differently: a missing scanner stays a scanner gap and does not
    // become a scan that never ran.
    const basisFor = (target: string): { source: SecurityEvidenceSource; state: SecurityEvidenceState } => {
        const basis =
            decision.applications.find((a) => a.target === target && a.state !== 'current') ??
            decision.records.find((r) => r.target === target && r.state !== 'current' && r.state !== 'partial');
        return basis
            ? { source: basis.source, state: basis.state }
            : { source: 'vulnerability_scan', state: 'not_evaluated' };
    };
    const added: EvidenceRuleApplication[] = targets
        // The evaluator now records the candidate rule itself for an unattended
        // pulling path, so a target it already covers is not recorded twice: one
        // image, one application. A node-wide application (the scanner gap)
        // covers every target in this decision, because the cause is the node,
        // not the image; a per-image one covers only its own target.
        .filter((target) => !decision.applications.some(
            (a) => a.rule.startsWith('security_candidate_unproven=')
                && (a.target === undefined || a.target === target),
        ))
        .map((target) => ({
            ...basisFor(target),
            outcome,
            rule: ruleClause('security_candidate_unproven', outcome),
            target,
        }));
    return {
        ...decision,
        applications: [...decision.applications, ...added],
        // The candidate's own decision, not the most restrictive of the two.
        // This object describes what happened to the candidate, and the two
        // statuses must agree: reporting `block` beside a `status: 'allowed'`
        // would say the candidate was both held and accepted. The deploy-gate
        // rules remain visible per application, which is where they belong.
        outcome,
        // Rebuilt rather than carried over. Carrying the pre-override summary
        // would leave this object claiming the outcome the deploy gate reached
        // while its `outcome` field says the candidate rule's. The outcome and the
        // applications are persisted with an accepted generation, so a reader of
        // that record sees one decision rather than two descriptions of it.
        summary: summarizeEvidenceApplications([...decision.applications, ...added]),
    };
}
