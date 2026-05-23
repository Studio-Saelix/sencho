/**
 * Tracks in-flight stack lifecycle operations (deploy, down, restart, stop,
 * start, update) per (nodeId, stackName). A second request to the same stack
 * while the first is still running returns 409 instead of racing the first.
 *
 * State is intentionally process-local: a Sencho restart clears all locks,
 * which matches the lifecycle of any in-flight `docker compose` child process.
 */

export type StackOpAction = 'deploy' | 'down' | 'restart' | 'stop' | 'start' | 'update';

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

  public get(nodeId: number, stackName: string): StackOpLock | undefined {
    return this.locks.get(this.key(nodeId, stackName));
  }

  public size(): number {
    return this.locks.size;
  }
}
