import { fetchForNode } from '@/lib/api';

export type StackLifecycleResult =
  | { ok: true }
  /** The stack's containers were removed, so there is nothing to start; deploying it recreates them. */
  | { ok: false; reason: 'no-containers'; message: string }
  | { ok: false; reason: 'failed'; message: string };

async function post(nodeId: number, stackName: string, action: 'start' | 'backup', service?: string): Promise<StackLifecycleResult> {
  const path = service === undefined
    ? `/stacks/${encodeURIComponent(stackName)}/${action}`
    : `/stacks/${encodeURIComponent(stackName)}/services/${encodeURIComponent(service)}/${action}`;
  const res = await fetchForNode(path, nodeId, { method: 'POST' });
  if (res.ok) return { ok: true };
  const body: unknown = await res.json().catch(() => null);
  const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  const message = typeof error === 'string' && error !== '' ? error : `${action} failed (HTTP ${res.status})`;
  // A 404 for a missing stack reads "Stack not found". The two messages matched
  // below mean the stack exists but has nothing to start: no containers at all, or
  // (service route) none belonging to that service. They couple to the wording in
  // the stack lifecycle routes.
  if (action === 'start' && res.status === 404 && (message.startsWith('No containers found') || (service !== undefined && message.startsWith('Service')))) return { ok: false, reason: 'no-containers', message };
  return { ok: false, reason: 'failed', message };
}

/** Start a stack's existing containers on the given node. */
export function startStack(nodeId: number, stackName: string): Promise<StackLifecycleResult> {
  return post(nodeId, stackName, 'start');
}

/** Start one service's existing containers on the given node. */
export function startService(nodeId: number, stackName: string, service: string): Promise<StackLifecycleResult> {
  return post(nodeId, stackName, 'start', service);
}

/** Capture a recovery point for a stack on the given node. */
export function backupStack(nodeId: number, stackName: string): Promise<StackLifecycleResult> {
  return post(nodeId, stackName, 'backup');
}
