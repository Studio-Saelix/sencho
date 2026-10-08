import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FindingRowActions } from '@/components/ui/finding-row-actions';
import type { DismissalMode } from '@/types/findingDismissal';
import type { NetworkingFinding, NetworkingRecommendedAction } from '@/types/networking';
import { SetExposureIntentPopover } from './SetExposureIntentPopover';
import { resolveNetworkingVerbs, type NetworkingVerb } from './networkingVerbs';

/** What the page wires into every finding row so the list and the Overview block act the same way. */
export interface NetworkingFindingControls {
  nodeId: number | undefined;
  isAdmin: boolean;
  /** Mirrors the stack-edit route guard. */
  canEditStack: (stack: string) => boolean;
  /** Runs a recommended action; the one handler the whole page uses. */
  onAction: (action: NetworkingRecommendedAction) => void | Promise<void>;
  onAcknowledge: (finding: NetworkingFinding) => void;
  /** A verb changed the finding's state, so the page should re-read it. */
  onResolved: () => void;
  /** Mirrors the dismissal route's guard for the finding's scope. */
  canDismiss: (finding: NetworkingFinding) => boolean;
  isDismissing: (finding: NetworkingFinding) => boolean;
  onDismiss: (finding: NetworkingFinding, mode: DismissalMode, days?: number) => void;
}

interface NetworkingFindingActionsProps {
  finding: NetworkingFinding;
  controls: NetworkingFindingControls;
}

/**
 * The action cluster for one networking finding, shared by the Findings list
 * and the Overview "Operator attention" block: its resolving verb, the rest in
 * an overflow menu, then Dismiss. Exposure intent is set in a popover over the
 * row, so it never leaves the page.
 */
export function NetworkingFindingActions({ finding, controls }: NetworkingFindingActionsProps) {
  const { nodeId, onAction, onAcknowledge, onResolved } = controls;
  const verbs = resolveNetworkingVerbs(finding, { isAdmin: controls.isAdmin, canEditStack: controls.canEditStack });
  const run = (verb: NetworkingVerb): void => {
    if (verb.action.kind === 'acknowledge-in-doctor') onAcknowledge(finding);
    else void onAction(verb.action);
  };
  const primary = verbs.primary;

  return (
    <FindingRowActions
      dismissPolicy={finding.dismissPolicy}
      canDismiss={controls.canDismiss(finding)}
      pending={controls.isDismissing(finding)}
      subject={finding.title}
      onDismiss={(mode, days) => controls.onDismiss(finding, mode, days)}
    >
      {primary !== null && (primary.action.kind === 'set-exposure-intent' && finding.stack !== undefined ? (
        <SetExposureIntentPopover
          stack={finding.stack}
          service={primary.action.service}
          nodeId={nodeId}
          label={primary.label}
          finding={finding}
          onSaved={onResolved}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs max-md:min-h-11"
          data-testid={`finding-verb-${finding.id}`}
          onClick={() => run(primary)}
        >
          {primary.label}
        </Button>
      ))}
      {verbs.more.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 max-md:min-h-11 max-md:min-w-11" aria-label={`More actions: ${finding.title}`}>
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {verbs.more.map(verb => (
              <DropdownMenuItem key={`${verb.action.kind}:${verb.label}`} onSelect={() => run(verb)}>
                {verb.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </FindingRowActions>
  );
}
