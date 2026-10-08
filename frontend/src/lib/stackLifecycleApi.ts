import { fetchForNode } from '@/lib/api';

export type StackLifecycleResult =
  | { ok: true }
  /** The stack's containers were removed, so there is nothing to start; deploying it recreates them. */
  | { ok: false; reason: 'no-containers'; message: string }
  | { ok: false; reason: 'failed'; message: string };

async function post(nodeId: number, stackName: string, action: 'start' | 'backup'): Promise<StackLifecycleResult> {
  const res = await fetchForNode(`/stacks/${encodeURIComponent(stackName)}/${action}`, nodeId, { method: 'POST' });
  if (res.ok) return { ok: true };
  const body: unknown = await res.json().catch(() => null);
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  const message = typeof error === 'string' && error !== '' ? error : `${action} failed (HTTP ${res.status})`;
  // A 404 for a missing stack reads "Stack not found"; this one means the stack
  // exists but has no containers to start.
  if (action === 'start' && res.status === 404 && message.startsWith('No containers found')) return { ok: false, reason: 'no-containers', message };
  return { ok: false, reason: 'failed', message };
}

/** Start a stack's existing containers on the given node. */
export function startStack(nodeId: number, stackName: string): Promise<StackLifecycleResult> {
  return post(nodeId, stackName, 'start');
}

/** Capture a recovery point for a stack on the given node. */
export function backupStack(nodeId: number, stackName: string): Promise<StackLifecycleResult> {
  return post(nodeId, stackName, 'backup');
}
