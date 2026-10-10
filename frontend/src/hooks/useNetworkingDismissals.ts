import { useNodeDismissals } from '@/hooks/useNodeDismissals';

/** The team's networking dismissals for one node; see `useNodeDismissals`. */
export function useNetworkingDismissals(nodeId: number | undefined, reloadKey: number, onGone: () => void) {
  return useNodeDismissals('networking', nodeId, reloadKey, onGone);
}
