import type { PreflightStatus } from '../preflight/types';
import type { UpdatePreviewSummary } from '../UpdatePreviewService';
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
  input: { status: PreflightStatus } | Errored,
): ReadinessSignal {
  const base = { id: 'preflight' as const, title: 'Compose Doctor' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'The stored preflight report could not be read.' };
  }
  switch (input.status) {
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

export function containersSignal(input: ContainerProbe[] | Errored): ReadinessSignal {
  const base = { id: 'containers' as const, title: 'Current containers' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: true, detail: 'Container state could not be read from Docker.' };
  }
  if (input.length === 0) {
    return { ...base, status: 'warning', affectsVerdict: true, detail: 'The stack is not running; updating will start it.' };
  }
  const troubled = input.filter(
    c => c.health === 'unhealthy' || c.state === 'restarting' || (c.state === 'exited' && (c.exitCode ?? 0) !== 0),
  );
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

export function updatePreviewSignal(input: UpdatePreviewSummary | Errored): ReadinessSignal {
  const base = { id: 'update_preview' as const, title: 'Pending update' };
  if (input === 'error') {
    return { ...base, status: 'unknown', affectsVerdict: false, detail: 'The update preview is unavailable.' };
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
  if (input.has_update) {
    const kind = input.update_kind === 'digest' ? 'a same-tag image refresh' : `a ${input.semver_bump} update`;
    return { ...base, status: 'ok', affectsVerdict: true, detail: `Pending: ${kind}.` };
  }
  return { ...base, status: 'ok', affectsVerdict: true, detail: 'No pending image update detected; the update re-pulls and recreates with current tags.' };
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
   * "error" must not read as a failed preview).
   */
  rollbackTarget: { target: string | null } | Errored;
  /** Timestamp of the most recent deploy_success activity event, if any. */
  lastDeployAt: number | null | Errored;
  containers: ContainerProbe[] | Errored;
}

export function buildRollbackItems(inputs: RollbackInputs, now: number): RollbackReadinessItem[] {
  const items: RollbackReadinessItem[] = [];

  const backupExists = inputs.backup !== 'error' && inputs.backup.exists;
  if (inputs.backup === 'error') {
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
  } else if (inputs.rollbackTarget.target) {
    items.push({ id: 'previous_images', state: 'ready', label: 'Previous image tag', detail: `Known rollback target: ${inputs.rollbackTarget.target}. If the compose file uses a moving tag, restoring files alone does not revert the image; pin this tag to be exact.` });
  } else {
    items.push({ id: 'previous_images', state: 'unknown', label: 'Previous image tag', detail: 'The previous image tag could not be determined. A rollback restores compose and env files; a moving tag may keep the newer image.' });
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

  const mounts = inputs.containers === 'error'
    ? []
    : [...new Set(inputs.containers.flatMap(c => c.mounts))];
  const mountDetail = mounts.length > 0 ? ` This stack mounts: ${mounts.join(', ')}.` : '';
  items.push({
    id: 'volume_data',
    state: 'not_covered',
    label: 'Application data',
    detail: `Named volumes and bind-mounted data are not included in file backups. Rolling back restores compose and env files only; application data keeps its current state.${mountDetail}`,
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
  if (byId.get('compose_source') !== 'ready') {
    return byId.get('compose_source') === 'unknown' ? 'partial' : 'not_ready';
  }
  if (byId.get('env_keys') === 'ready' && byId.get('previous_images') === 'ready') {
    return 'ready';
  }
  return 'partial';
}
