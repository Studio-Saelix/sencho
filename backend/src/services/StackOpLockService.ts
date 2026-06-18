/**
 * Tracks in-flight stack lifecycle operations (deploy, down, restart, stop,
 * start, update, rollback, backup) per (nodeId, stackName). A second request to
 * the same stack while the first is still running returns 409 instead of racing
 * the first. Backup is included because it rewrites the shared rollback slot, so
 * it must not interleave with a deploy/update/rollback on the same stack.
 *
 * State is intentionally process-local: a Sencho restart clears all locks,
 * which matches the lifecycle of any in-flight `docker compose` child process.
 */

export type StackOpAction = 'deploy' | 'down' | 'restart' | 'stop' | 'start' | 'update' | 'rollback' | 'backup';

/**
 * Note returned by a background path that skipped its operation because a manual
 * or concurrent operation already held the stack's lock.
 */
export function stackOpSkipMessage(stackName: string, existingAction: StackOpAction): string {
  return `Skipped "${stackName}": another operation (${existingAction}) is already in progress.`;
}

export interface StackOpLock {
  action: StackOpAction;
  startedAt: number;
  user: string;
}

interface AcquireSuccess {
  acquired: true;
}

interface AcquireConflict {
  acquired: false;
  existing: StackOpLock;
}

export type AcquireResult = AcquireSuccess | AcquireConflict;

export class StackOpLockService {
  private static instance: StackOpLockService;
  private readonly locks = new Map<string, StackOpLock>();

  public static getInstance(): StackOpLockService {
    if (!this.instance) this.instance = new StackOpLockService();
    return this.instance;
  }

  public static resetForTests(): void {
    this.instance = new StackOpLockService();
  }

  private key(nodeId: number, stackName: string): string {
    return `${nodeId}:${stackName}`;
  }

  public tryAcquire(
    nodeId: number,
    stackName: string,
    action: StackOpAction,
    user: string,
  ): AcquireResult {
    const k = this.key(nodeId, stackName);
    const existing = this.locks.get(k);
    if (existing) return { acquired: false, existing };
    this.locks.set(k, { action, startedAt: Date.now(), user });
    return { acquired: true };
  }

  public release(nodeId: number, stackName: string): void {
    this.locks.delete(this.key(nodeId, stackName));
  }

  /**
   * Acquire the per-(nodeId, stackName) lock for the duration of `fn`, then
   * release it. Returns `{ ran: true, result }` when the lock was free, or
   * `{ ran: false, existing }` when another operation already holds it, so the
   * caller can skip rather than race. Background/system paths (scheduler,
   * webhook, Git source, image auto-update, label bulk actions, fleet snapshot
   * redeploy, mesh redeploy) run their lifecycle calls through this so they
   * cannot interleave with a manual deploy/update/rollback/backup on the same
   * stack and node. An error thrown by `fn` still releases the lock, then
   * propagates to the caller.
   */
  public async runExclusive<T>(
    nodeId: number,
    stackName: string,
    action: StackOpAction,
    user: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; result: T } | { ran: false; existing: StackOpLock }> {
    const acquired = this.tryAcquire(nodeId, stackName, action, user);
    if (!acquired.acquired) return { ran: false, existing: acquired.existing };
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      this.release(nodeId, stackName);
    }
  }

  public get(nodeId: number, stackName: string): StackOpLock | undefined {
    return this.locks.get(this.key(nodeId, stackName));
  }

  public size(): number {
    return this.locks.size;
  }
}
