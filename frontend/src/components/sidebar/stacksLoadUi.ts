import type { StacksLoadStatus } from '@/components/EditorLayout/hooks/useStackListState';

/** True when the sidebar stack list request has finished for the active node. */
export function isStacksListSettled(
  isLoading: boolean,
  stacksLoadStatus: StacksLoadStatus | undefined,
): boolean {
  return !isLoading && (stacksLoadStatus === 'success' || stacksLoadStatus === 'error');
}

/** True while the sidebar should show the stack-list skeleton. */
export function isStacksListLoading(
  isLoading: boolean,
  stacksLoadStatus: StacksLoadStatus | undefined,
): boolean {
  return isLoading || stacksLoadStatus === 'idle' || stacksLoadStatus === 'loading' || stacksLoadStatus == null;
}
