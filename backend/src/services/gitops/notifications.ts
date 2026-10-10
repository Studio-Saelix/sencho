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
import { settledOutcomeCarriesNews } from './outcomes';

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
 * `health_finalized` is absent for the opposite reason: a recorded health
 * failure already reaches the bell as `health_gate_failed`, written by the gate
 * that produced the verdict. A second entry for the same event would tell an
 * operator the same thing twice, so the posture has a notification behind it
 * without adding one here.
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
  'health_rollout_policy_set',
  'placement_policy_changed',
  'rollout_authorization_policy_changed',
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
 * `after` is the transition's own `after` record, and it is required rather than
 * optional because one arm's decision depends on what the transition recorded.
 * Both call sites already hold it, so requiring it keeps the two from being able
 * to disagree about an outcome-dependent stage, which is the exact failure this
 * function exists to prevent.
 */
export function gitOpsOutboxPlan(
  stage: GitOpsHistoryStage,
  targetMode: GitOpsTargetMode,
  after: Record<string, unknown>,
): GitOpsOutboxPlan | null {
  if (stage === 'source_reconcile_settled') {
    // A settled attempt that carries no news does not notify. The portfolio
    // reports the same application as in progress, staged, suspended,
    // superseded, or waiting on an armed retry, and a bell entry per poll would
    // be a surface reporting the state it is already showing. What has not
    // changed is the portfolio's to report; the bell reports the changes. A
    // malformed outcome reads as unknown here, the same value the outbox insert
    // writes, so a damaged row is suppressed rather than inserted and silently
    // dropped at drain time.
    const outcome = typeof after.outcome === 'string' ? after.outcome : 'unknown';
    if (!settledOutcomeCarriesNews(outcome)) return null;
    return { kind: 'settled' };
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
 * How a settled attempt's notification is rendered in the bell.
 *
 * This is presentation only. It deliberately does not reach the dedupe key:
 * one attempt settles into exactly one outcome, so keying per outcome family
 * would let two writers that classify the same event differently (a live
 * apply-failure write against the settle that confirms it) produce two entries
 * for one attempt. The key is per attempt, where there is nothing to disagree
 * about.
 *
 * A scheduled retry is deliberately not a family of its own: it is a steady
 * state the no-news rule suppresses, and the failure it follows announced
 * itself when it happened.
 */
export type SettledNotificationFamily = 'ready' | 'blocked' | 'failed';

export const SETTLED_FAMILY_NOTIFICATION: Record<
  SettledNotificationFamily,
  { category: NotificationCategory; level: 'info' | 'warning' | 'error' }
> = {
  ready: { category: 'git_pull_ready', level: 'info' },
  blocked: { category: 'git_plan_blocked', level: 'warning' },
  failed: { category: 'git_pull_failed', level: 'error' },
};

export function settledNotificationFamily(outcome: string): SettledNotificationFamily {
  if (outcome === 'blocked') return 'blocked';
  if (
    outcome === 'failed_previous_intact'
    || outcome === 'recovery_required'
    || outcome === 'unknown'
  ) {
    return 'failed';
  }
  return 'ready';
}

/**
 * The state a staged candidate is waiting in, which is part of its identity.
 *
 * `awaiting_review` and `blocked` are standing states: the candidate keeps
 * settling into them on every poll, so each announces once and then stays
 * silent. `held` is a change rather than a state to sit in (a safety refusal
 * turned an automatic candidate into one needing review), and it gets its own
 * candidate key so the operator sees it instead of it colliding with the entry
 * the candidate wrote when it was staged.
 */
export type GitOpsCandidateState = 'awaiting_review' | 'blocked' | 'held';

/**
 * The staged candidate an event announces, when it announces one.
 *
 * Identified by the candidate generation rather than the commit, so a commit
 * that is legitimately staged again later (after an apply, or after the
 * candidate was discarded and re-staged) is a new candidate and announces
 * again, while a poll that settles the same waiting candidate stays silent.
 */
export type GitOpsCandidateIdentity = {
  applicationId: string;
  generationId: string;
  state: GitOpsCandidateState;
};

/**
 * The dedupe key one attempt owns.
 *
 * The fetch path announces a result when it stages or fails, and the settled
 * attempt announces the same result after the transition commits. Both write
 * this key, so the second is a no-op and the operator reads one entry for one
 * event instead of two. Stable per attempt, so a replay after a crash between
 * insert and mark-drained collides with the first write too.
 *
 * Per attempt, not per attempt and outcome: one attempt produces one outcome,
 * so a per-outcome key would let the two writers collide only when they happen
 * to classify the event identically, which is exactly the property that must
 * not be assumed (a live apply-failure write and the settle that confirms it
 * classify the same failure differently by construction).
 *
 * An event that is about a staged candidate is keyed to the candidate instead.
 * A candidate settles the same outcome on every poll, whether it is waiting on
 * review or blocked by a local conflict, and a per-attempt key would notify once
 * per interval for as long as it waits. The candidate key makes the poll that
 * staged it the one that announces it, a newly staged candidate the thing that
 * announces again, and a review that turns into a hold the thing that announces
 * the hold.
 */
export function gitOpsAttemptNotificationKey(
  operationId: string,
  candidate?: GitOpsCandidateIdentity,
): string {
  if (candidate) {
    return `gitops:candidate:${candidate.applicationId}:${candidate.generationId}:${candidate.state}`;
  }
  return `gitops:attempt:${operationId}`;
}

/**
 * The state a live candidate row is waiting in, or null when there is none.
 *
 * Read from the application row rather than re-derived from the settled
 * outcome, because the two disagree on purpose: a candidate blocked by a local
 * conflict settles `blocked`, while a held candidate settles `pending_review`
 * even though the hold is what the operator needs to see.
 */
export function gitOpsCandidateState(
  application: {
    candidate_generation_id: string | null;
    candidate_plan_blocked: number | null;
    review_block_reason: string | null;
  },
): GitOpsCandidateState | null {
  if (!application.candidate_generation_id) return null;
  if (application.candidate_plan_blocked === 1) return 'blocked';
  if (application.review_block_reason !== null) return 'held';
  return 'awaiting_review';
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
  // An operator changing what a health outcome may do to a rollout. Notified
  // because it decides whether a future rollout can stop or restore work across
  // the fleet, and an audit reader has to see the change and who made it.
  health_rollout_policy_set: { category: 'gitops_health_rollout_policy_set', level: 'info', phrase: 'health rollout policy changed' },
  // An operator changing what may place or withdraw a workload without one.
  // Notified for the same reason as the health policy above: it decides in
  // advance what the system may do to each node, so an audit reader has to
  // see the change and who made it.
  placement_policy_changed: { category: 'gitops_placement_policy_changed', level: 'info', phrase: 'placement policy changed' },
  rollout_authorization_policy_changed: { category: 'gitops_rollout_authorization_policy_changed', level: 'info', phrase: 'rollout authorization policy changed' },
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
