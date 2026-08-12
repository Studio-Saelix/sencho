import type { StacksLoadStatus } from '@/components/EditorLayout/hooks/useStackListState';

/** True when the sidebar stack list request has finished for the active node.
 *  A completed list error settles regardless of status hydration; a successful
 *  list is fully settled only once status hydration is no longer pending, so
 *  readiness sentinels (E2E `data-stacks-loaded`) stay truthful. */
export function isStacksListSettled(
  isLoading: boolean,
  stacksLoadStatus: StacksLoadStatus | undefined,
  hydrationStatus?: 'pending' | 'ok' | 'error',
): boolean {
  if (isLoading) return false;
  if (stacksLoadStatus === 'error') return true;
  if (stacksLoadStatus !== 'success') return false;
  return hydrationStatus !== 'pending';
}

/** True while the sidebar should show the stack-list skeleton. */
export function isStacksListLoading(
  isLoading: boolean,
  stacksLoadStatus: StacksLoadStatus | undefined,
): boolean {
  return isLoading || stacksLoadStatus === 'idle' || stacksLoadStatus === 'loading' || stacksLoadStatus == null;
}
