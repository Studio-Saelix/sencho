/**
 * The GitOps notification vocabulary.
 *
 * A committed transition becomes a notification-history entry only when it is
 * named here. The stage union in `history.ts` is the closed set every producer
 * can write; this module narrows it to the subset an operator needs to be told
 * about (an authority decision, a rollout lifecycle change, or a deploy held
 * for confirmation) and pins each one to the category, level, and message
 * phrase the notification carries.
 *
 * The mapping is one-to-one on purpose. A stage that later gains a second
 * notification meaning needs a second category rather than a conditional in
 * the outbox, because the category is what suppression rules and the bell
 * group on.
 *
 * These categories are history-only, like the `git_*` source-attempt
 * categories: they reach the bell and the Activity timeline through
 * `DatabaseService.addNotificationHistory`, and nothing dispatches them to
 * external channels. That matches how the source-attempt notifications already
 * behave, and a channel dispatch would be its own reviewed decision rather
 * than a side effect of adding a stage here.
 */
import type { GitOpsHistoryStage } from './history';
import type { NotificationCategory } from '../NotificationService';

/**
 * Every stage that produces a notification-history entry.
 *
 * `satisfies readonly GitOpsHistoryStage[]` is the tripwire: a stage named
 * here that no producer writes fails the build.
 *
 * `source_reconcile_settled` is deliberately absent. It notifies too, but
 * through the settled-attempt payload (`attemptPayload.ts` v1), whose
 * outcome-dependent mapping predates this list. `hasGitOpsOutboxRow` is the
 * union of the two, and it is the predicate both the insert and the drain use
 * so they cannot disagree about which rows exist.
 */
export const NOTIFIABLE_GITOPS_STAGES = [
  'source_accepted',
  'placement_approved',
  'rollout_authorized',
  'rollout_paused',
  'rollout_unpaused',
  'rollout_generation_superseded',
  'rollback_in_progress',
  'rollback_completed',
  'rollback_partial_failed',
  'blueprint_state_review',
] as const satisfies readonly GitOpsHistoryStage[];

export type NotifiableGitOpsStage = (typeof NOTIFIABLE_GITOPS_STAGES)[number];

const NOTIFIABLE_SET: ReadonlySet<string> = new Set(NOTIFIABLE_GITOPS_STAGES);

export function isNotifiableGitOpsStage(value: string): value is NotifiableGitOpsStage {
  return NOTIFIABLE_SET.has(value);
}

/**
 * Whether the given stage writes an outbox row.
 *
 * One predicate rather than two call sites comparing stage strings, because
 * the insert (`history.ts`) and the drain (`publish.ts`) must agree about
 * which rows exist. A stage that inserts no row is never drained, and a stage
 * that inserts one nobody drains is a notification that never fires.
 */
export function hasGitOpsOutboxRow(stage: GitOpsHistoryStage): boolean {
  return stage === 'source_reconcile_settled' || isNotifiableGitOpsStage(stage);
}

/**
 * How one notifiable stage reaches the notification history.
 *
 * `phrase` completes "GitOps <phrase> for <application>": the stage names the
 * event, the phrase is the operator sentence. `level` is the severity the bell
 * and the Activity timeline render.
 */
export type GitOpsNotificationMeta = {
  category: NotificationCategory;
  level: 'info' | 'warning' | 'error';
  phrase: string;
};

export const GITOPS_NOTIFICATION_META: Record<NotifiableGitOpsStage, GitOpsNotificationMeta> = {
  source_accepted: { category: 'gitops_source_accepted', level: 'info', phrase: 'source accepted' },
  placement_approved: { category: 'gitops_placement_approved', level: 'info', phrase: 'placement approved' },
  rollout_authorized: { category: 'gitops_rollout_authorized', level: 'info', phrase: 'rollout authorized' },
  rollout_paused: { category: 'gitops_rollout_paused', level: 'warning', phrase: 'rollout paused' },
  rollout_unpaused: { category: 'gitops_rollout_resumed', level: 'info', phrase: 'rollout resumed' },
  rollout_generation_superseded: { category: 'gitops_rollout_superseded', level: 'warning', phrase: 'rollout superseded' },
  rollback_in_progress: { category: 'gitops_rollback_started', level: 'warning', phrase: 'rollback started' },
  rollback_completed: { category: 'gitops_rollback_completed', level: 'info', phrase: 'rollback completed' },
  rollback_partial_failed: { category: 'gitops_rollback_partial_failed', level: 'error', phrase: 'rollback partially failed' },
  blueprint_state_review: { category: 'gitops_stateful_confirmation', level: 'warning', phrase: 'stateful deploy awaiting confirmation' },
};

/**
 * Dedupe key for one event notification.
 *
 * Distinct from the settled prefix so the two kinds stay tellable apart in
 * `notification_history`, and stable per history row so a replay after a
 * crash between insert and mark-drained collides with the first notification
 * instead of producing a second.
 */
export function gitOpsEventNotificationDedupeKey(historyId: string): string {
  return `gitops:event:${historyId}`;
}

/**
 * The operator-supplied reason on a transition delta, when one was recorded.
 *
 * Pause stages write `pauseReason`; the failure and source-attempt stages
 * write `reason`. An absent or empty value stays null rather than becoming an
 * empty suffix in the message.
 */
export function gitOpsNotificationReason(after: Record<string, unknown>): string | null {
  if (typeof after.reason === 'string' && after.reason.length > 0) return after.reason;
  if (typeof after.pauseReason === 'string' && after.pauseReason.length > 0) return after.pauseReason;
  return null;
}
