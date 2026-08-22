/**
 * Counters for GitOps revision transitions, one increment per history row that
 * was actually inserted.
 *
 * Process-local and in-memory, the same bargain StackOpMetricsService makes: a
 * restart clears the counters, and persisting them would put a write on every
 * transition for very little operator value. The durable record is
 * `gitops_history` itself, which these counters only summarise.
 *
 * The keyspace is finite by construction. `GitOpsHistoryStage` is a closed
 * union of everything a producer can write and `HistoryOutcome` is a closed
 * CHECK set of six, so the map cannot exceed their product however much traffic
 * arrives. No identity, stack name, node, actor, or repository is recorded:
 * a counter that carried those would be an audit trail with no retention rules
 * and no authorization, which is what the history API is for.
 */
import type { GitOpsHistoryStage, HistoryOutcome } from './gitops/history';

export interface GitOpsMetricEntry {
  stage: GitOpsHistoryStage;
  outcome: HistoryOutcome;
  count: number;
}

export class GitOpsMetricsService {
  private static instance: GitOpsMetricsService;
  private readonly buckets = new Map<string, GitOpsMetricEntry>();

  public static getInstance(): GitOpsMetricsService {
    if (!GitOpsMetricsService.instance) {
      GitOpsMetricsService.instance = new GitOpsMetricsService();
    }
    return GitOpsMetricsService.instance;
  }

  public static resetForTests(): void {
    this.instance = new GitOpsMetricsService();
  }

  /**
   * Count one transition.
   *
   * Called once per newly inserted history row, never on a dedupe replay: a
   * replay is the same transition arriving twice, and counting it would report
   * retries as activity.
   */
  public record(stage: GitOpsHistoryStage, outcome: HistoryOutcome): void {
    const key = `${stage}:${outcome}`;
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      return;
    }
    this.buckets.set(key, { stage, outcome, count: 1 });
  }

  /**
   * Every bucket that has been touched, ordered by stage then outcome.
   *
   * Untouched pairs are absent rather than zero. Ordering is stable so an
   * operator pulling this twice can diff the two responses directly. Each
   * bucket is copied, so a reader cannot edit the counters through the
   * snapshot it was handed.
   */
  public snapshot(): GitOpsMetricEntry[] {
    return [...this.buckets.values()]
      .map((bucket) => ({ ...bucket }))
      .sort((a, b) => a.stage.localeCompare(b.stage) || a.outcome.localeCompare(b.outcome));
  }
}
