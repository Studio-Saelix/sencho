import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { DismissedList, type DismissedItem } from '@/components/ui/dismissed-section';
import type { FindingDismissal } from '@/types/findingDismissal';
import type { DismissedFinding } from '@/lib/findingDismissals';
import type { FleetReadinessNode, ReadinessFinding } from '@/types/readiness';
import { codeCopy } from '../readinessMeta';
import { describeDismissal } from './describeDismissal';

interface ReadinessDismissedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every finding a dismissal still covers, not narrowed by the findings filter, so the list matches the count that opened it. */
  dismissed: DismissedFinding<ReadinessFinding>[];
  nodes: FleetReadinessNode[];
  now: number;
  canDismiss: (finding: ReadinessFinding) => boolean;
  onRestore: (dismissal: FindingDismissal) => void;
  isRestoring: (dismissal: FindingDismissal) => boolean;
}

/**
 * The fleet's dismissed findings: who set each aside, when, and for how long,
 * with Restore. Opens from the dismissed count in the readiness status row, so
 * a long list never pushes the node matrix down the page.
 */
export function ReadinessDismissedSheet({ open, onOpenChange, dismissed, nodes, now, canDismiss, onRestore, isRestoring }: ReadinessDismissedSheetProps) {
  const nodeNames = new Map(nodes.map(node => [node.id, node.name]));
  const items: DismissedItem[] = dismissed.map(({ finding, dismissal }) => ({
    id: dismissal.id,
    title: `${codeCopy(finding.code)} · ${[nodeNames.get(finding.nodeId) ?? `node ${finding.nodeId}`, finding.stack].filter(Boolean).join(' / ')}`,
    meta: describeDismissal(dismissal, now),
    onRestore: canDismiss(finding) ? () => onRestore(dismissal) : undefined,
    restoring: isRestoring(dismissal),
  }));

  return (
    <SystemSheet
      open={open}
      onOpenChange={onOpenChange}
      crumb={['Fleet', 'Readiness']}
      name="Dismissed findings"
      meta={`${items.length} set aside · still counted, never hidden`}
    >
      <SheetSection title={`Dismissed · ${items.length}`}>
        {items.length > 0
          ? <DismissedList items={items} flush />
          : <p className="py-8 text-center text-sm text-muted-foreground">Nothing is dismissed.</p>}
      </SheetSection>
    </SystemSheet>
  );
}
