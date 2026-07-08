import type { StacksLoadStatus } from './hooks/useStackListState';

export interface PendingDetailClearInput {
  pendingDetailStack: string | null;
  detailReady: boolean;
  isFileLoading: boolean;
  stacksLoadStatus: StacksLoadStatus;
  urlHydratingStack: string | null;
  routeDetailError: string | null;
}

/** Whether the optimistic mobile detail placeholder can be cleared. */
export function shouldClearPendingDetailStack(input: PendingDetailClearInput): boolean {
  if (!input.pendingDetailStack) return false;
  if (input.routeDetailError) return false;
  if (input.urlHydratingStack) return false;
  if (input.detailReady) return true;
  if (input.isFileLoading) return false;
  if (input.stacksLoadStatus === 'loading' || input.stacksLoadStatus === 'idle') return false;
  return false;
}
