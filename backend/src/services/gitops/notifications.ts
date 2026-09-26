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
 * the outbox, because the category is what a bell filter and a mute rule name.
 *
 * These categories are history-only, like the `git_*` source-attempt
 * categories: they reach the bell through
 * `DatabaseService.addNotificationHistory` (and the stack Activity timeline
 * for an application that has a stack name), and nothing dispatches them to
 * external channels. That matches how the source-attempt notifications already
 * behave, and a channel dispatch would be its own reviewed decision rather
 * than a side effect of adding a stage here.
 */
import type { GitOpsHistoryStage } from './history';
import type { GitOpsTargetMode } from './types';
import type { NotificationCategory } from '../NotificationService';

/**
 * Every stage that produces a notification-history entry.
 *
 * `satisfies readonly GitOpsHistoryStage[]` is the tripwire: a stage named
 * here that is not in the producer-writable union fails the build. The
 * reverse direction is not compile-checked, because most of the union is
 * deliberately silent; adding a stage to `history.ts` does not by itself
 * require a decision here, and that decision is made in review.
 *
 * `source_reconcile_settled` is deliberately absent. It notifies too, but
 * through the settled-attempt payload (`attemptPayload.ts` v1), whose
 * outcome-dependent mapping predates this list. `gitOpsOutboxPlan` is the
 * union of the two, and it is the one function both the insert and the drain
 * call, so they cannot disagree about which rows exist.
 *
 * `health_finalized` is listed because a recorded failure is the one health
 * verdict an operator must be told about, and the projection reports it as
 * `failed` posture with a `health_failed` reason, so a surface that stays
 * silent leaves the posture with no notification behind it. The stage itself
 * fires for every verdict, so `gitOpsOutboxPlan` narrows it to the failure
 * arm; being in this list is what puts the entry in the metadata table, not
 * what makes it notify.
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
  'health_finalized',
] as const satisfies readonly GitOpsHistoryStage[];

export type NotifiableGitOpsStage = (typeof NOTIFIABLE_GITOPS_STAGES)[number];

const NOTIFIABLE_SET: ReadonlySet<string> = new Set(NOTIFIABLE_GITOPS_STAGES);

export function isNotifiableGitOpsStage(value: string): value is NotifiableGitOpsStage {
  return NOTIFIABLE_SET.has(value);
}

/**
 * Which payload an outbox row carries. The event arm carries the narrowed
 * stage so the insert's payload takes it without a second check.
 */
export type GitOpsOutboxPlan =
  | { kind: 'settled' }
  | { kind: 'event'; stage: NotifiableGitOpsStage };

/**
 * Decide the outbox row, if any, a committed transition writes.
 *
 * One function rather than two call sites comparing stage strings, because
 * the insert (`history.ts`) and the drain (`publish.ts`) must agree about
 * which rows exist. A stage that inserts no row is never drained, and a stage
 * that inserts one nobody drains is a notification that never fires.
 *
 * `after` is the transition's own `after` record, and it is required rather
 * than optional because the decision for a health verdict depends on what the
 * verdict was. Both call sites already hold it, so requiring it keeps the two
 * from being able to disagree about an outcome-dependent stage, which is the
 * exact failure this function exists to prevent.
 */
export function gitOpsOutboxPlan(
  stage: GitOpsHistoryStage,
  targetMode: GitOpsTargetMode,
  after: Record<string, unknown>,
): GitOpsOutboxPlan | null {
  if (stage === 'source_reconcile_settled') return { kind: 'settled' };
  // Only a recorded failure notifies. `recordedVerdict` is the verdict the
  // transition actually persisted, not the one it was handed: a verdict that
  // could not be tied to the running stack is not recorded, and an `unknown`
  // verdict over an existing one is discarded. Keying this on the incoming
  // verdict would notify about a failure the projection does not report, since
  // the projection reads the recorded value too.
  //
  // `passed` is the ordinary outcome and would fire on every health update, so
  // the successful arm is silent on purpose.
  if (stage === 'health_finalized') {
    return after.recordedVerdict === 'failed' ? { kind: 'event', stage } : null;
  }
  if (!isNotifiableGitOpsStage(stage)) return null;
  // A Direct source acceptance is the source controller's automatic
  // bookkeeping, and the settled attempt already tells the operator that a
  // revision arrived. The decomposed acceptance step is a Git-managed
  // Blueprint decision.
  if (stage === 'source_accepted' && targetMode === 'direct') return null;
  return { kind: 'event', stage };
}

/**
 * How one notifiable stage reaches the notification history.
 *
 * `phrase` completes "GitOps <phrase> for <application>": the stage names the
 * event, the phrase is the operator sentence. `level` is the severity the bell
 * renders.
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
  health_finalized: { category: 'gitops_health_failed', level: 'error', phrase: 'health check failed' },
};

/**
 * The pause reason a transition delta recorded, when it recorded one.
 *
 * Only the pause stages carry operator free text today. A later notifiable
 * stage that records its reason under another key adds that key here rather
 * than being guessed at, and an absent or empty value stays null instead of
 * becoming an empty suffix in the message.
 */
export function gitOpsPauseReason(after: Record<string, unknown>): string | null {
  return typeof after.pauseReason === 'string' && after.pauseReason.length > 0
    ? after.pauseReason
    : null;
}
