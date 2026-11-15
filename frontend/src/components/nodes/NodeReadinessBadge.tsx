import { Badge } from '@/components/ui/badge';
import { STATUS_CARD_CLASS } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
import type { Node } from '@/context/NodeContext';
import { nodeReadinessLabel } from './nodeReadinessLabel';

/** The readiness word for a bootstrapped node, wherever the node is listed. See `nodeReadinessLabel`. */
export function NodeReadinessBadge({ readiness, className }: { readiness: Node['readiness']; className?: string }) {
  const label = nodeReadinessLabel(readiness);
  if (!label) return null;
  return (
    <Badge
      size="compact"
      variant="outline"
      className={cn(STATUS_CARD_CLASS[label.tone], className)}
      title={label.title}
      data-testid="node-readiness-badge"
      data-state={readiness?.state}
    >
      {label.word}
    </Badge>
  );
}
