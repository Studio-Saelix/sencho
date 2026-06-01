export interface UpdateTracker {
  status: 'updating' | 'completed' | 'timeout' | 'failed';
  startedAt: number;
  previousVersion: string | null;
  error?: string;
  /** Process start time of the remote node before the update was triggered. */
  previousProcessStart: number | null;
  /** True when the node became unreachable at least once during the update window. */
  wasOffline: boolean;
  /** Timestamp when the tracker transitioned to a terminal state (completed/failed/timeout). */
  resolvedAt?: number;
}

export type TerminalStatus = 'completed' | 'failed' | 'timeout';

/** Hard ceiling for an in-flight update before it is declared timed out. */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const UPDATE_TIMEOUT_MSG = 'Node did not come back online within 5 minutes.';
/** How long a resolved `completed` tracker lingers before it is reaped, so the
 *  badge stays briefly visible after the update lands. */
export const TERMINAL_TTL_MS = 60 * 1000;

/**
 * In-memory tracker for in-flight fleet node updates. Keyed by node id.
 *
 * State is intentionally process-local: a restart clears all trackers, which
 * is correct because the primary's own restart means it cannot observe remote
 * update progress anyway. Fleet routes consume this service to render and
 * clear update status.
 */
export class FleetUpdateTrackerService {
  private static instance: FleetUpdateTrackerService;
  private readonly trackers = new Map<number, UpdateTracker>();

  public static getInstance(): FleetUpdateTrackerService {
    if (!FleetUpdateTrackerService.instance) {
      FleetUpdateTrackerService.instance = new FleetUpdateTrackerService();
    }
    return FleetUpdateTrackerService.instance;
  }

  public get(nodeId: number): UpdateTracker | undefined {
    return this.trackers.get(nodeId);
  }

  public set(nodeId: number, tracker: UpdateTracker): void {
    this.trackers.set(nodeId, tracker);
  }

  public delete(nodeId: number): boolean {
    return this.trackers.delete(nodeId);
  }

  public entries(): IterableIterator<[number, UpdateTracker]> {
    return this.trackers.entries();
  }

  public size(): number {
    return this.trackers.size;
  }

  /** Create a new tracker with `startedAt=now` and resolvedAt set if terminal. */
  public create(
    status: UpdateTracker['status'],
    previousVersion: string | null,
    previousProcessStart: number | null,
    error?: string,
  ): UpdateTracker {
    const now = Date.now();
    return {
      status,
      startedAt: now,
      previousVersion,
      previousProcessStart,
      wasOffline: false,
      error,
      resolvedAt: status !== 'updating' ? now : undefined,
    };
  }

  /** Return a copy of `tracker` transitioned to a terminal state, with resolvedAt=now. */
  public resolve(tracker: UpdateTracker, status: TerminalStatus, error?: string): UpdateTracker {
    return { ...tracker, status, resolvedAt: Date.now(), error };
  }

  /**
   * Safety-net sweep driven off the monitor tick rather than the frontend poll.
   * The `/api/fleet/update-status` poll is the primary resolver, but it only
   * runs while a client is watching; this bounds trackers when nothing polls:
   * an in-flight tracker past the ceiling is timed out, and a resolved
   * `completed` badge past its visibility window is reaped (mirroring the
   * poll's auto-expire). Failed/timeout trackers persist until the operator
   * dismisses them, matching the poll's behaviour. Returns counts for logging.
   */
  public sweepStale(): { timedOut: number; reaped: number } {
    const now = Date.now();
    let timedOut = 0;
    let reaped = 0;
    for (const [nodeId, tracker] of this.trackers) {
      if (tracker.status === 'updating') {
        if (now - tracker.startedAt > UPDATE_TIMEOUT_MS) {
          this.trackers.set(nodeId, this.resolve(tracker, 'timeout', UPDATE_TIMEOUT_MSG));
          timedOut++;
        }
      } else if (tracker.status === 'completed' && tracker.resolvedAt && now - tracker.resolvedAt > TERMINAL_TTL_MS) {
        this.trackers.delete(nodeId);
        reaped++;
      }
    }
    return { timedOut, reaped };
  }
}
