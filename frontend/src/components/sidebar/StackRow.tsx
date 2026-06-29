import type { ReactNode } from 'react';
import { GitBranch, Loader2, AlertCircle } from 'lucide-react';
import type { CheckStatus } from '@/types/imageUpdates';
import { Cursor, CursorContainer, CursorFollow, CursorProvider } from '@/components/animate-ui/primitives/animate/cursor';
import { Checkbox } from '@/components/ui/checkbox';
import type { Label } from '@/components/label-types';
import { cn } from '@/lib/utils';
import { sidebarRowActive, sidebarRowBase, sidebarRowCheckboxSlot } from './sidebar-styles';
import { statusText, statusColor } from './stack-status-utils';
import type { StackRowStatus } from './stack-status-utils';

interface StackRowProps {
  file: string;
  displayName: string;
  status: StackRowStatus;
  // Running/total container counts (set for any stack with containers); consumed only for the partial-stack pill tooltip.
  running?: number;
  total?: number;
  isBusy: boolean;
  isActive: boolean;
  labels: Label[];
  hasUpdate: boolean;
  // Last image-update check outcome. 'failed' surfaces a muted "couldn't check"
  // indicator so an undeterminable check is not mistaken for "up to date".
  checkStatus?: CheckStatus;
  lastError?: string;
  hasGitPending: boolean;
  onSelect: (file: string) => void;
  kebabSlot: ReactNode;
  bulkMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (file: string) => void;
}

function RowTooltip({ trigger, label }: { trigger: ReactNode; label: string }) {
  return (
    <CursorProvider>
      <CursorContainer className="inline-flex items-center shrink-0">{trigger}</CursorContainer>
      <Cursor><div className="h-2 w-2 rounded-full bg-brand" /></Cursor>
      <CursorFollow side="bottom" sideOffset={4} align="center" transition={{ stiffness: 400, damping: 40, bounce: 0 }}>
        <div className="rounded-md border border-card-border bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] px-2.5 py-1.5 shadow-md">
          <span className="font-mono text-xs tabular-nums text-stat-value">{label}</span>
        </div>
      </CursorFollow>
    </CursorProvider>
  );
}

export function StackRow(props: StackRowProps) {
  const {
    file, displayName, status, running, total, isBusy, isActive,
    hasUpdate, checkStatus, lastError, hasGitPending, onSelect, kebabSlot,
    bulkMode = false, isSelected = false, onToggleSelect,
  } = props;

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

      {/* Status pill. Partial stacks add a hover tooltip with the running/total count. */}
      <span className={cn('font-mono text-[10px] shrink-0 w-[22px] flex items-center', statusColor(status, isBusy))}>
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

      {/* Fixed trailing icon slot: update dot > check-failed > git pending */}
      <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
        {hasUpdate ? (
          <RowTooltip
            trigger={(
              <span className="relative inline-flex w-2 h-2">
                <span className="absolute inset-0 rounded-full bg-update opacity-75 animate-ping" />
                <span className="relative w-2 h-2 rounded-full bg-update" />
              </span>
            )}
            label="Update available"
          />
        ) : checkStatus === 'failed' ? (
          <RowTooltip
            trigger={<AlertCircle className="w-3 h-3 text-muted-foreground/70" strokeWidth={1.5} />}
            label={lastError ? `Update check failed: ${lastError}` : 'Update check failed'}
          />
        ) : hasGitPending ? (
          <RowTooltip
            trigger={<GitBranch className="w-3 h-3 text-brand" strokeWidth={1.5} />}
            label="Git source update pending"
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
