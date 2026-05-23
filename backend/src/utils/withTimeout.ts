/**
 * Bounded-wait wrapper for promises that may never settle.
 *
 * Promise.race does not cancel the losing promise. A timed-out Docker API or
 * systeminformation call continues running in the background until it
 * resolves or the process exits. True cancellation would require
 * AbortController plumbing through every caller (DockerController, dockerode,
 * systeminformation), which is a structural limitation of the codebase.
 *
 * The trade-off is acceptable for monitor cycles and admin request handlers:
 * the caller gets bounded latency, and the orphan promise carries no
 * observable side effects once the timeout fires.
 */
export class TimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`Timeout: ${label} after ${ms}ms`);
        this.name = 'TimeoutError';
    }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
