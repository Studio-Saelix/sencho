import type { ReactNode } from 'react';
import { GitBranch, Loader2, AlertCircle } from 'lucide-react';
import type { CheckStatus } from '@/types/imageUpdates';
import { isConfirmedImageUpdate } from '@/types/imageUpdates';
import { Checkbox } from '@/components/ui/checkbox';
import type { Label } from '@/components/label-types';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { sidebarRowActive, sidebarRowBase, sidebarRowCheckboxSlot } from './sidebar-styles';
import { statusText, statusColor } from './stack-status-utils';
import type { StackRowStatus } from './stack-status-utils';
import { updateAvailableLabel } from '@/lib/updateAvailableLabel';
import { SOURCE_STATE_LOOKUP } from '@/lib/gitopsState';
import type { GitOpsSourceStatus } from '@/types/gitops';

interface StackRowProps {
  file: string;
  displayName: string;
  status: StackRowStatus;
  // Running/total container counts (set for any stack with containers); consumed only for the partial-stack pill tooltip.
  running?: number;
  total?: number;
  /** Hydration display projection: pending/error force unknown indicators,
   *  stale dims the pill, current/incomplete render normally. */
  hydrationDisplay?: 'pending' | 'error' | 'current' | 'stale' | 'incomplete';
  isBusy: boolean;
  isActive: boolean;
  labels: Label[];
  hasUpdate: boolean;
  /** Outdated service names for the update tooltip; empty keeps the generic label. */
  outdatedServices?: string[];
  // Last image-update check outcome. Incomplete/failed checks with hasUpdate
  // use a distinct indicator so they are not mistaken for a confirmed update.
  checkStatus?: CheckStatus;
  lastError?: string;
  /**
   * The source state of a waiting Git candidate, or null when none is waiting.
   * The indicator itself is identical for every state; only the tooltip differs,
   * so a blocked plan reads as blocked instead of as an ordinary update.
   */
  gitPending: GitOpsSourceStatus | null;
  onSelect: (file: string) => void;
  kebabSlot: ReactNode;
  bulkMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (file: string) => void;
}

function RowTooltip({ trigger, label }: { trigger: ReactNode; label: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4} align="center">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function appendErrorDetail(base: string, lastError?: string): string {
  if (!lastError) return base;
  return `${base} ${lastError}`;
}

function partialUpdateTooltip(hasUpdate: boolean, lastError?: string): string {
  if (hasUpdate) {
    // Neutral copy: partial + hasUpdate can mean newly detected OR retained;
    // provenance is not persisted on the wire.
    return appendErrorDetail(
      'The last check was incomplete; an update was detected or retained, but the full stack could not be verified.',
      lastError,
    );
  }
  return appendErrorDetail(
    'The last image-update check was incomplete; update status could not be fully verified.',
    lastError,
  );
}

function failedCheckTooltip(hasUpdate: boolean, lastError?: string): string {
  if (hasUpdate) {
    return appendErrorDetail(
      'Previous update status retained; the last check failed.',
      lastError,
    );
  }
  return lastError ? `Update check failed: ${lastError}` : 'Update check failed';
}

export function StackRow(props: StackRowProps) {
  const {
    file, displayName, status, running, total, isBusy, isActive,
    hasUpdate, outdatedServices, checkStatus, lastError, gitPending, onSelect, kebabSlot,
    bulkMode = false, isSelected = false, onToggleSelect,
    hydrationDisplay = 'pending',
  } = props;

  const staleEvidence = hydrationDisplay === 'stale';

  const confirmedUpdate = isConfirmedImageUpdate({ hasUpdate, checkStatus });
  const partialIncomplete = checkStatus === 'partial';
  const failedCheck = checkStatus === 'failed';

  const handleClick = () => {
    if (bulkMode) onToggleSelect?.(file);
    else onSelect(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      data-testid="stack-row"
      data-bulk={bulkMode ? 'true' : undefined}
      role="button"
      tabIndex={0}
      className={cn(sidebarRowBase, isActive && sidebarRowActive)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span
        className={cn(sidebarRowCheckboxSlot, bulkMode && 'opacity-100 pointer-events-auto')}
        onClick={e => { e.stopPropagation(); onToggleSelect?.(file); }}
        aria-hidden={!bulkMode}
      >
        {bulkMode && (
          <Checkbox
            checked={isSelected}
            className="w-3.5 h-3.5 border-muted-foreground/40 data-[state=checked]:border-brand data-[state=checked]:bg-brand"
            tabIndex={-1}
            aria-label={`Select ${displayName}`}
          />
        )}
      </span>

      {/* Status pill. Partial stacks add a hover tooltip with the running/total
          count. Hydration state shapes the pill: pending stays muted, error
          turns the unknown indicator warning-colored (distinct from pending),
          stale dims the retained value so it is never read as current. */}
      <span
        title={staleEvidence ? 'Status data is stale' : undefined}
        className={cn(
          'font-mono text-[10px] shrink-0 w-[22px] flex items-center',
          hydrationDisplay === 'error' ? 'text-warning' : statusColor(status, isBusy),
          staleEvidence && 'opacity-50',
        )}
      >
        {isBusy ? (
          <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
        ) : status === 'partial' && running !== undefined && total !== undefined ? (
          <RowTooltip trigger={<span>{statusText(status)}</span>} label={`${running}/${total} running`} />
        ) : (
          statusText(status)
        )}
      </span>

      {/* Stack name */}
      <span className="flex-1 truncate font-mono text-sm min-w-0">{displayName}</span>

      {/* Trailing: confirmed update > partial incomplete > failed > git pending */}
      <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0" data-testid="stack-row-trailing">
        {confirmedUpdate ? (
          <RowTooltip
            trigger={(
              <span className="relative inline-flex w-2 h-2" data-testid="stack-trailing-update">
                <span className="absolute inset-0 rounded-full bg-update opacity-75 animate-ping" />
                <span className="relative w-2 h-2 rounded-full bg-update" />
              </span>
            )}
            label={updateAvailableLabel(outdatedServices)}
          />
        ) : partialIncomplete ? (
          <RowTooltip
            trigger={<span data-testid="stack-trailing-check-partial"><AlertCircle className="w-3 h-3 text-warning-foreground/80" strokeWidth={1.5} /></span>}
            label={partialUpdateTooltip(hasUpdate, lastError)}
          />
        ) : failedCheck ? (
          <RowTooltip
            trigger={<span data-testid="stack-trailing-check-failed"><AlertCircle className="w-3 h-3 text-muted-foreground/70" strokeWidth={1.5} /></span>}
            label={failedCheckTooltip(hasUpdate, lastError)}
          />
        ) : gitPending ? (
          <RowTooltip
            trigger={<span data-testid="stack-trailing-git-pending"><GitBranch className="w-3 h-3 text-brand" strokeWidth={1.5} /></span>}
            label={SOURCE_STATE_LOOKUP[gitPending]?.line ?? 'A Git update is waiting on this stack.'}
          />
        ) : null}
      </span>

      {/* Kebab: always rightmost. Hover-revealed on desktop; always visible on
          touch viewports where there is no hover. */}
      <div
        className="opacity-0 group-hover:opacity-100 max-md:opacity-100 transition-opacity flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {kebabSlot}
      </div>
    </div>
  );
}
