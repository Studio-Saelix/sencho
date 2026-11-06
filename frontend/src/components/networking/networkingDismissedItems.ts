import type { DismissedItem } from '@/components/ui/dismissed-sheet';
import { describeDismissal } from '@/components/fleet/readiness/describeDismissal';
import type { DismissedNetworkingFinding } from '@/lib/networkingDismissals';
import type { NetworkingDismissedList } from './NetworkingFindingsList';

function dismissedMeta(item: DismissedNetworkingFinding, now: number): string {
  return item.dismissal === null ? 'acknowledged in Compose Doctor' : describeDismissal(item.dismissal, now);
}

/** The dismissed findings as sheet rows, shared by the Findings tab and the Overview block. */
export function networkingDismissedItems(dismissed: NetworkingDismissedList): DismissedItem[] {
  return dismissed.items.map(item => ({
    id: item.dismissal?.id ?? `ack:${item.finding.id}`,
    title: item.finding.title,
    meta: dismissedMeta(item, dismissed.now),
    onRestore: dismissed.canRestore(item) ? () => dismissed.onRestore(item) : undefined,
    restoring: dismissed.isRestoring(item),
  }));
}
