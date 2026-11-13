import { useId } from 'react';
import { ChevronDown, DiagramFlowHorizontal, Plug2, RefreshCcwDot, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { cn } from '@/lib/utils';
import type { NodeManagementActions } from './types';

const SECTION_LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';

/**
 * The Fleet toolbar's single node-management control.
 *
 * It owns no domain logic: each item calls the handler the caller already has.
 * Unavailable actions are hidden, not disabled; only the transient in-flight
 * update check is disabled.
 */
export function NodeManagementMenu({ actions }: { actions: NodeManagementActions }) {
  const onboardingLabelId = useId();
  const maintenanceLabelId = useId();
  const { showBusy } = useVisualBusy(actions.checkingUpdates);
  const showOnboarding = actions.canConnectExisting || actions.canBootstrapServer;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 shrink-0" data-node-management-trigger="true">
          <DiagramFlowHorizontal className="w-4 h-4" strokeWidth={1.5} aria-hidden />
          Node management
          <ChevronDown className="w-3.5 h-3.5 text-stat-subtitle" strokeWidth={1.5} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {showOnboarding && (
          <>
            <DropdownMenuGroup aria-labelledby={onboardingLabelId}>
              <DropdownMenuLabel id={onboardingLabelId} className={SECTION_LABEL_CLASS}>
                Onboarding
              </DropdownMenuLabel>
              {actions.canConnectExisting && (
                <DropdownMenuItem onSelect={actions.onConnectExisting} className="[&>svg]:size-3.5">
                  <Plug2 className="w-3.5 h-3.5 mr-2" strokeWidth={1.5} aria-hidden />
                  Connect existing node
                </DropdownMenuItem>
              )}
              {actions.canBootstrapServer && (
                <DropdownMenuItem onSelect={actions.onBootstrapServer} className="[&>svg]:size-3.5">
                  <ServerCog className="w-3.5 h-3.5 mr-2" strokeWidth={1.5} aria-hidden />
                  Bootstrap new Linux server
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup aria-labelledby={maintenanceLabelId}>
          <DropdownMenuLabel id={maintenanceLabelId} className={SECTION_LABEL_CLASS}>
            Maintenance
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={actions.onCheckUpdates}
            disabled={actions.checkingUpdates}
            aria-busy={actions.checkingUpdates || undefined}
            className="[&>svg]:size-3.5"
          >
            <RefreshCcwDot className={cn('w-3.5 h-3.5 mr-2', showBusy && 'animate-spin')} strokeWidth={1.5} aria-hidden />
            Node updates
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
