import type { PreflightStatus } from '../preflight/types';
import type { UpdatePreviewImage, UpdatePreviewSummary } from '../UpdatePreviewService';
import type {
  ContainerProbe,
  ReadinessSignal,
  ReadinessVerdict,
  RollbackOverall,
  RollbackReadinessItem,
  SignalStatus,
} from './types';

/**
 * Pure readiness scoring. UpdateGuardService gathers the inputs (each of which
 * degrades independently to the 'error' sentinel) and these functions map them
 * to signals and a verdict, so every grading rule is synchronously testable.
 */

/** Sentinel for an input whose collection failed. */
export type Errored = 'error';

const formatAge = (timestamp: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export function preflightSignal(
  input: { activeStatus: PreflightStatus } | Errored,
): ReadinessSignal {
  const base = { id: 'preflight' as const, title: 'Compose Doctor' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'The stored preflight report could not be read.' };
  }
  switch (input.activeStatus) {
    case 'never-run':
      return { ...base, status: 'unknown', affectsVerdict: false, detail: 'Compose Doctor has not been run for this stack yet. Run it for a deeper pre-update check.' };
    case 'blocker':
      return { ...base, status: 'blocked', affectsVerdict: true, detail: 'The last preflight found a blocker. Resolve it before updating.' };
    case 'unrenderable':
      return { ...base, status: 'attention', affectsVerdict: true, detail: 'The compose file did not render in the last preflight; the update is likely to fail the same way.' };
    case 'high':
      return { ...base, status: 'attention', affectsVerdict: true, detail: 'The last preflight found high-risk findings. Review them before updating.' };
    case 'warning':
      return { ...base, status: 'warning', affectsVerdict: true, detail: 'The last preflight found warnings.' };
    case 'pass':
    case 'info':
      return { ...base, status: 'ok', affectsVerdict: true, detail: 'The last preflight passed.' };
  }
}

export function driftSignal(input: number | Errored): ReadinessSignal {
  const base = { id: 'drift' as const, title: 'Drift' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'Drift findings could not be read.' };
  }
  if (input > 0) {
    const plural = input === 1 ? 'finding' : 'findings';
    return {
      ...base,
      status: 'warning',
      affectsVerdict: true,
      detail: `${input} open drift ${plural}: the running state has diverged from the compose file, so the rollback target may not match what is running.`,
    };
  }
  return { ...base, status: 'ok', affectsVerdict: true, detail: 'No open drift findings.' };
}

/** A container already unhealthy, restarting, or crash-exited before any update runs. */
export function isTroubledContainer(c: ContainerProbe): boolean {
  return c.health === 'unhealthy' || c.state === 'restarting' || (c.state === 'exited' && (c.exitCode ?? 0) !== 0);
}

export function containersSignal(input: ContainerProbe[] | Errored): ReadinessSignal {
  const base = { id: 'containers' as const, title: 'Current containers' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: true, detail: 'Container state could not be read from Docker.' };
  }
  if (input.length === 0) {
    return { ...base, status: 'warning', affectsVerdict: true, detail: 'The stack is not running; updating will start it.' };
  }
  const troubled = input.filter(isTroubledContainer);
  if (troubled.length > 0) {
    const names = troubled.map(c => c.name).join(', ');
    return {
      ...base,
      status: 'attention',
      affectsVerdict: true,
      detail: `Already unhealthy before the update: ${names}. An update on top of a failing stack is hard to evaluate; consider fixing or stopping it first.`,
    };
  }
  return { ...base, status: 'ok', affectsVerdict: true, detail: `${input.length} container${input.length === 1 ? '' : 's'} running normally.` };
}

export function healthchecksSignal(input: ContainerProbe[] | Errored): ReadinessSignal {
  const base = { id: 'healthchecks' as const, title: 'Healthcheck coverage', status: 'ok' as SignalStatus, affectsVerdict: false };
  if (input === 'error' || input.length === 0) {
    return { ...base, detail: 'Coverage is unknown until the stack runs. Containers without healthchecks are verified by run state only after an update.' };
  }
  const withCheck = input.filter(c => c.hasHealthcheck).length;
  const withoutRestart = input.filter(c => !c.restartPolicy || c.restartPolicy === 'no').length;
  const parts = [
    `${withCheck} of ${input.length} container${input.length === 1 ? '' : 's'} define a healthcheck; the rest are verified by run state only after an update.`,
  ];
  if (withoutRestart > 0) {
    parts.push(`${withoutRestart} ha${withoutRestart === 1 ? 's' : 've'} no restart policy.`);
  }
  return { ...base, detail: parts.join(' ') };
}

/**
 * True when a full-stack apply would pull/recreate an image whose digest
 * verification failed as collateral of applying a DIFFERENT image's confirmed
 * update or a local rebuild. `has_update` and `check_error` are independent
 * per image (a tag-based update can be confirmed via the registry's tag list
 * even when that same image's own digest comparison errored), so this
 * excludes the case where the only verification failure belongs to the very
 * image whose update is confirmed: that image's own stale-digest check does
 * not block moving it to a newer tag. Falls back to the aggregate summary
 * flags when per-image detail is unavailable.
 */
function hasUnverifiedOtherImage(summary: UpdatePreviewSummary, images: UpdatePreviewImage[] | undefined): boolean {
  if (!images || images.length === 0) {
    return summary.verification_failed && (summary.has_update || summary.rebuild_available);
  }
  const hasPureFailureImage = images.some((i) => Boolean(i.check_error) && !i.has_update);
  if (!hasPureFailureImage) return false;
  return images.some((i) => i.has_update) || summary.rebuild_available;
}

export function updatePreviewSignal(input: UpdatePreviewSummary | Errored, images?: UpdatePreviewImage[]): ReadinessSignal {
  const base = { id: 'update_preview' as const, title: 'Pending update' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'The update preview is unavailable.' };
  }
  if (input.detection_disabled) {
    return {
      ...base,
      status: 'unknown',
      affectsVerdict: false,
      detail: 'Image update detection is disabled for this node.',
    };
  }
  if (input.blocked) {
    return {
      ...base,
      status: 'blocked',
      affectsVerdict: true,
      detail: input.blocked_reason ?? 'A scan policy blocks this update.',
    };
  }
  if (input.has_update && input.semver_bump === 'major') {
    const change = input.current_tag && input.next_tag ? ` (${input.current_tag} to ${input.next_tag})` : '';
    return { ...base, status: 'attention', affectsVerdict: true, detail: `A major version bump is pending${change}. Review the upstream changelog for breaking changes.` };
  }
  if (input.has_update && input.semver_bump === 'unknown') {
    return { ...base, status: 'warning', affectsVerdict: true, detail: 'An image update is pending but the version change could not be classified.' };
  }
  // A DIFFERENT image in the stack failing digest verification holds any
  // pending action (a tag/digest update or a local-build rebuild) for review,
  // since a full-stack apply would pull/recreate the unverified image as
  // collateral. has_update and rebuild_available are handled symmetrically
  // here to match isReviewRequiredUpdatePreview on the frontend.
  const reviewRequired = hasUnverifiedOtherImage(input, images);
  if (input.has_update) {
    const kind = input.update_kind === 'digest' ? 'a same-tag image refresh' : `a ${input.semver_bump} update`;
    const buildNote = input.has_build_services
      ? ' Local build services will also be rebuilt from source.'
      : '';
    if (reviewRequired) {
      const verifyNote = input.verification_error ? `: ${input.verification_error}` : '.';
      return {
        ...base,
        status: 'attention',
        affectsVerdict: true,
        detail: `Pending: ${kind}.${buildNote} Another image failed digest verification${verifyNote} Review before a full-stack update.`,
      };
    }
    return { ...base, status: 'ok', affectsVerdict: true, detail: `Pending: ${kind}.${buildNote}` };
  }
  if (input.rebuild_available) {
    const n = input.has_build_services ? 'Local build service(s)' : 'Build';
    const rebuildNote = `${n} require a rebuild from source; the update rebuilds images and recreates containers.`;
    if (reviewRequired) {
      const verifyNote = input.verification_error ? `: ${input.verification_error}` : '.';
      return {
        ...base,
        status: 'attention',
        affectsVerdict: true,
        detail: `${rebuildNote} Another image failed digest verification${verifyNote} Review before a full-stack update.`,
      };
    }
    return { ...base, status: 'warning', affectsVerdict: true, detail: rebuildNote };
  }
  if (input.verification_failed) {
    return {
      ...base,
      status: 'unknown',
      affectsVerdict: true,
      detail: input.verification_error
        ? `Digest verification failed: ${input.verification_error}`
        : 'Digest verification failed; Sencho is not claiming a rebuild.',
    };
  }
  return { ...base, status: 'ok', affectsVerdict: true, detail: 'No pending image update detected; the update re-pulls and recreates with current tags.' };
}

export function buildServicesSignal(buildServices: string[] | Errored): ReadinessSignal {
  const base = { id: 'build_services' as const, title: 'Local build services', affectsVerdict: false };
  if (buildServices === 'error') {
    return { ...base, status: 'unknown', detail: 'Build services could not be detected from the compose model.' };
  }
  if (buildServices.length === 0) {
    return { ...base, status: 'ok', detail: 'No services declare a local build; the update pulls registry images only.' };
  }
  const plural = buildServices.length === 1 ? 'service' : 'services';
  const names = buildServices.join(', ');
  return {
    ...base,
    status: 'warning',
    detail: `${buildServices.length} ${plural} (${names}) rebuild from source. This may take longer and depends on the local Dockerfile context, network access, and base-image availability.`,
  };
}

/** Model-membership facts for the selected service, gathered from EffectiveServiceModel. */
export type ServiceMembership =
  | { found: false }
  | { found: true; hasBuild: boolean; declaredImage: string | null; expectedReplicas: number };

/** Matches `ServiceUpdateRecoveryService`'s digest-pin check (a recovery snapshot is never eligible for a digest-pinned declared ref). */
const DIGEST_PIN_RE = /@sha256:[a-f0-9]{64}$/i;

/**
 * Selected-service signal for a service-scoped readiness check: model
 * membership and whether the update would leave a rollback recovery snapshot
 * behind. Render failure or a missing service fails closed (blocked), never
 * unknown, so a service-scoped check cannot silently proceed against a stale
 * or absent model.
 */
export function serviceSignal(input: ServiceMembership | Errored): ReadinessSignal {
  const base = { id: 'service' as const, title: 'Selected service' };
  if (input === 'error') {
    return { ...base, status: 'blocked', affectsVerdict: true, detail: 'The compose model could not be rendered, so the selected service cannot be validated. Resolve the compose error before updating.' };
  }
  if (!input.found) {
    return { ...base, status: 'blocked', affectsVerdict: true, detail: 'The selected service is not declared in this stack\u2019s compose model.' };
  }
  if (!input.hasBuild && !input.declaredImage) {
    return { ...base, status: 'blocked', affectsVerdict: true, detail: 'The selected service has neither an image nor a build, so it cannot be updated.' };
  }
  const digestPinned = input.declaredImage !== null && DIGEST_PIN_RE.test(input.declaredImage);
  if (!input.declaredImage || digestPinned) {
    const reason = !input.declaredImage ? 'it builds from source with no declared image' : 'its declared image is pinned to a digest';
    return {
      ...base,
      status: 'warning',
      affectsVerdict: true,
      detail: `Declared with ${input.expectedReplicas} expected replica${input.expectedReplicas === 1 ? '' : 's'}. No rollback recovery snapshot will be available for this update because ${reason}.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    affectsVerdict: true,
    detail: `Declared with ${input.expectedReplicas} expected replica${input.expectedReplicas === 1 ? '' : 's'}; a rollback recovery snapshot will be captured before the update.`,
  };
}

export function backupSlotSignal(
  input: { exists: boolean; timestamp: number | null } | Errored,
  now: number,
): ReadinessSignal {
  const base = { id: 'backup_slot' as const, title: 'Rollback backup' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'The backup slot could not be read.' };
  }
  if (!input.exists) {
    return { ...base, status: 'warning', affectsVerdict: true, detail: 'No rollback backup exists yet; one is created automatically when the update starts.' };
  }
  const age = input.timestamp ? ` (from ${formatAge(input.timestamp, now)})` : '';
  return { ...base, status: 'ok', affectsVerdict: true, detail: `A compose and env file backup exists${age} and is refreshed when the update starts.` };
}

export function diskSignal(
  input: { usePercent: number; limitPercent: number } | null | Errored,
): ReadinessSignal {
  const base = { id: 'disk' as const, title: 'Node disk' };
  if (input === 'error' || input === null) {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'Disk usage could not be read.' };
  }
  const use = Math.round(input.usePercent);
  if (input.usePercent >= input.limitPercent) {
    return { ...base, status: 'attention', affectsVerdict: true, detail: `Disk usage is at ${use}%, at or above the ${input.limitPercent}% alert threshold. Image pulls may fail; free space first.` };
  }
  if (input.usePercent >= input.limitPercent - 5) {
    return { ...base, status: 'warning', affectsVerdict: true, detail: `Disk usage is at ${use}%, close to the ${input.limitPercent}% alert threshold.` };
  }
  return { ...base, status: 'ok', affectsVerdict: true, detail: `Disk usage is at ${use}%.` };
}

/**
 * Severity precedence: blocked > attention (review required) > verdict-affecting
 * unknown > warning > ready. Informational unknowns never affect the verdict.
 */
export function aggregateVerdict(signals: ReadinessSignal[]): ReadinessVerdict {
  const affecting = signals.filter(s => s.affectsVerdict);
  if (affecting.some(s => s.status === 'blocked')) return 'blocked';
  if (affecting.some(s => s.status === 'attention')) return 'review_required';
  if (affecting.some(s => s.status === 'unknown')) return 'unknown';
  if (affecting.some(s => s.status === 'warning')) return 'ready_with_warnings';
  return 'ready';
}

// ── Rollback readiness ───────────────────────────────────────────────────────

export interface RollbackInputs {
  backup: { exists: boolean; timestamp: number | null } | Errored;
  envSummary: { exists: boolean; envPresent: boolean; keys: string[] } | Errored;
  /** Whether the stack currently has an env file (distinguishes "no env to cover"). */
  stackHasEnv: boolean | Errored;
  /**
   * UpdatePreview.rollback_target wrapped in an object so the Errored sentinel
   * cannot be absorbed into the string domain (an image literally named
   * "error" must not read as a failed preview). `moving` is true when any image
   * in the stack uses a moving tag (latest, a branch, an unpinned major/minor),
   * in which case restoring files does not revert the image because the local
   * tag already resolves to the newer digest.
   */
  rollbackTarget: { target: string | null; moving: boolean } | Errored;
  /** Timestamp of the most recent deploy_success activity event, if any. */
  lastDeployAt: number | null | Errored;
  containers: ContainerProbe[] | Errored;
  /**
   * Current recovery generation, when one exists. When present, compose_source
   * readiness is driven by this generation rather than the legacy backup slot.
   */
  recoveryGeneration: { exists: boolean; shortId?: string } | Errored | null;
  /** Eligibility verdict for the current generation, when assessed. */
  policyEligibility: 'eligible' | 'eligible_with_warning' | 'prohibited' | 'unknown' | Errored | null;
  /** Whether managed authored inputs are covered by exact inventory. */
  managedInputs: { covered: boolean; detail: string } | Errored | null;
}

export function buildRollbackItems(inputs: RollbackInputs, now: number): RollbackReadinessItem[] {
  const items: RollbackReadinessItem[] = [];

  const recoveryRaw = inputs.recoveryGeneration;
  const recoveryInfo = recoveryRaw !== null && recoveryRaw !== 'error' ? recoveryRaw : null;
  const recoveryExists = !!recoveryInfo?.exists;
  const backupExists = inputs.backup !== 'error' && inputs.backup.exists;

  if (recoveryRaw === 'error') {
    items.push({ id: 'recovery_generation', state: 'unknown', label: 'Recovery generation', detail: 'The recovery generation could not be read.' });
  } else if (recoveryInfo?.exists) {
    const short = recoveryInfo.shortId;
    items.push({
      id: 'recovery_generation',
      state: 'ready',
      label: 'Recovery generation',
      detail: short
        ? `Current recovery generation ${short} is available for exact restore.`
        : 'A current recovery generation is available for exact restore.',
    });
  } else {
    items.push({
      id: 'recovery_generation',
      state: 'missing',
      label: 'Recovery generation',
      detail: 'No recovery generation is current yet. One is created by the next update, atomic deploy, or Git apply.',
    });
  }

  // Supersede rule: when a recovery generation exists, compose_source tracks it.
  if (recoveryExists) {
    items.push({
      id: 'compose_source',
      state: 'ready',
      label: 'Previous compose file',
      detail: 'Authored project files are covered by the current recovery generation.',
    });
  } else if (inputs.backup === 'error') {
    items.push({ id: 'compose_source', state: 'unknown', label: 'Previous compose file', detail: 'The backup slot could not be read.' });
  } else if (backupExists) {
    const age = inputs.backup.timestamp ? ` from ${formatAge(inputs.backup.timestamp, now)}` : '';
    items.push({ id: 'compose_source', state: 'ready', label: 'Previous compose file', detail: `A backup${age} is available to restore.` });
  } else {
    items.push({ id: 'compose_source', state: 'missing', label: 'Previous compose file', detail: 'No backup exists yet. One is created automatically by the next update or deploy.' });
  }

  if (inputs.envSummary === 'error') {
    items.push({ id: 'env_keys', state: 'unknown', label: 'Previous env file', detail: 'The backed-up env file could not be read.' });
  } else if (inputs.envSummary.envPresent) {
    const n = inputs.envSummary.keys.length;
    items.push({ id: 'env_keys', state: 'ready', label: 'Previous env file', detail: `${n} variable name${n === 1 ? '' : 's'} captured in the backup (values are restored with the file, never shown here).` });
  } else if (inputs.stackHasEnv === true && backupExists) {
    items.push({ id: 'env_keys', state: 'missing', label: 'Previous env file', detail: 'The stack has an env file but the backup does not contain one; a rollback would not restore env changes.' });
  } else if (!backupExists) {
    items.push({ id: 'env_keys', state: 'missing', label: 'Previous env file', detail: 'No backup exists yet.' });
  } else {
    items.push({ id: 'env_keys', state: 'ready', label: 'Previous env file', detail: 'The stack uses no env file, so there is nothing to restore.' });
  }

  if (inputs.rollbackTarget === 'error') {
    items.push({ id: 'previous_images', state: 'unknown', label: 'Previous image tag', detail: 'The update preview is unavailable.' });
  } else if (inputs.rollbackTarget.target && inputs.rollbackTarget.moving) {
    items.push({ id: 'previous_images', state: 'ready', label: 'Previous image tag', detail: `Rollback target ${inputs.rollbackTarget.target}. This stack uses a moving image tag. Full-stack updates capture the running image ID before pull/build and retain it through the recovery window so an immediate restore can retarget the exact prior image, not only the tag string.` });
  } else if (inputs.rollbackTarget.target) {
    items.push({ id: 'previous_images', state: 'ready', label: 'Previous image tag', detail: `Known rollback target: ${inputs.rollbackTarget.target}. The compose file pins an immutable tag, so restoring files also restores the image.` });
  } else {
    items.push({ id: 'previous_images', state: 'unknown', label: 'Previous image tag', detail: 'The previous image tag could not be determined. When no prior image is recorded, a restore may fall back to compose and env files alone; a moving tag can still resolve to a newer digest.' });
  }

  if (inputs.lastDeployAt === 'error') {
    items.push({ id: 'last_deploy', state: 'unknown', label: 'Last successful deploy', detail: 'The activity history could not be read.' });
  } else if (inputs.lastDeployAt) {
    items.push({ id: 'last_deploy', state: 'ready', label: 'Last successful deploy', detail: `Recorded ${formatAge(inputs.lastDeployAt, now)}; the backup reflects a configuration that deployed successfully.` });
  } else {
    items.push({ id: 'last_deploy', state: 'missing', label: 'Last successful deploy', detail: 'No successful deploy is recorded in the recent activity history.' });
  }

  if (inputs.containers === 'error') {
    items.push({ id: 'healthchecks', state: 'unknown', label: 'Healthchecks', detail: 'Container state could not be read from Docker.' });
  } else if (inputs.containers.some(c => c.hasHealthcheck)) {
    items.push({ id: 'healthchecks', state: 'ready', label: 'Healthchecks', detail: 'At least one service defines a healthcheck, so a rollback can be verified beyond run state.' });
  } else {
    items.push({ id: 'healthchecks', state: 'missing', label: 'Healthchecks', detail: 'No service defines a healthcheck; rollback verification relies on run state only.' });
  }

  if (inputs.policyEligibility === 'error') {
    items.push({ id: 'policy_eligibility', state: 'unknown', label: 'Rollback eligibility', detail: 'Eligibility could not be assessed.' });
  } else if (inputs.policyEligibility === null) {
    items.push({ id: 'policy_eligibility', state: 'ready', label: 'Rollback eligibility', detail: 'No recovery generation to assess yet.' });
  } else if (inputs.policyEligibility === 'eligible') {
    items.push({ id: 'policy_eligibility', state: 'ready', label: 'Rollback eligibility', detail: 'Restore is eligible with known-good generation integrity and held images.' });
  } else if (inputs.policyEligibility === 'eligible_with_warning') {
    items.push({ id: 'policy_eligibility', state: 'warning', label: 'Rollback eligibility', detail: 'Restore is possible but held images may be missing; moving-tag recoverability is weak.' });
  } else if (inputs.policyEligibility === 'prohibited') {
    items.push({ id: 'policy_eligibility', state: 'blocked', label: 'Rollback eligibility', detail: 'Restore is prohibited until generation integrity or security posture is repaired.' });
  } else {
    items.push({ id: 'policy_eligibility', state: 'unknown', label: 'Rollback eligibility', detail: 'Eligibility is not fully known yet.' });
  }

  if (inputs.managedInputs === 'error') {
    items.push({ id: 'managed_inputs', state: 'unknown', label: 'Managed inputs', detail: 'Managed input coverage could not be read.' });
  } else if (inputs.managedInputs === null) {
    items.push({ id: 'managed_inputs', state: 'unknown', label: 'Managed inputs', detail: 'Managed input coverage has not been assessed.' });
  } else if (inputs.managedInputs.covered) {
    items.push({ id: 'managed_inputs', state: 'ready', label: 'Managed inputs', detail: inputs.managedInputs.detail });
  } else {
    items.push({ id: 'managed_inputs', state: 'warning', label: 'Managed inputs', detail: inputs.managedInputs.detail });
  }

  const mounts = inputs.containers === 'error'
    ? []
    : [...new Set(inputs.containers.flatMap(c => c.mounts))];
  const mountDetail = mounts.length > 0 ? ` This stack mounts: ${mounts.join(', ')}.` : '';
  items.push({
    id: 'volume_data',
    state: 'not_covered',
    label: 'Application data',
    detail: `Named volumes and bind-mounted data are not included in recovery generations. Rolling back restores the managed authored project (compose files, overrides, includes/extends, env and related inputs), Git identity when captured, and prior image holds; application data keeps its current state.${mountDetail}`,
  });

  return items;
}

/**
 * compose_source gates not_ready; ready additionally requires env coverage and
 * a known previous image tag. volume_data, healthchecks, and last_deploy are
 * disclosures and never gate the overall state.
 */
export function aggregateRollbackOverall(items: RollbackReadinessItem[]): RollbackOverall {
  const byId = new Map(items.map(i => [i.id, i.state]));
  if (byId.get('policy_eligibility') === 'blocked') {
    return 'not_ready';
  }
  if (byId.get('compose_source') !== 'ready') {
    return byId.get('compose_source') === 'unknown' ? 'partial' : 'not_ready';
  }
  const policy = byId.get('policy_eligibility');
  if (policy === 'unknown' || policy === 'warning') {
    return 'partial';
  }
  if (byId.get('env_keys') === 'ready' && byId.get('previous_images') === 'ready') {
    return 'ready';
  }
  return 'partial';
}
