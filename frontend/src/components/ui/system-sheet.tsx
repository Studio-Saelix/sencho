import * as React from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

const KICKER_CLASS = 'font-mono text-[10px] uppercase tracking-[0.22em]';
const CRUMB_CLASS = `${KICKER_CLASS} text-stat-subtitle`;

type SystemSheetSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<SystemSheetSize, string> = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[720px]',
  xl: 'sm:max-w-[960px]',
};

export interface SystemSheetAction {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon?: LucideIcon;
}

export interface SystemSheetTab {
  id: string;
  label: string;
  count?: number;
}

export interface SystemSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Header
  crumb: string[];
  name: React.ReactNode;
  meta?: React.ReactNode;

  // Toolbar band (omit entirely when no actions provided)
  primaryAction?: SystemSheetAction;
  secondaryActions?: SystemSheetAction[];
  destructiveAction?: SystemSheetAction;

  // Tabs band (omit entirely when undefined)
  tabs?: SystemSheetTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;

  // Footer freshness band (omit entirely when undefined)
  footerContext?: React.ReactNode;

  size?: SystemSheetSize;
  /**
   * Skip wrapping the body in `<ScrollArea>`. Use when the sheet body manages its own
   * scroll regions (e.g. multi-pane file browsers). The caller is responsible for
   * keeping scrollbars to `<ScrollArea>` per §10 Scrollbars, AND for adding their own
   * body padding (`noScroll` skips the default `px-6 py-5` wrapper).
   */
  noScroll?: boolean;
  /**
   * Constrain the scrolling body to the sheet width and let any wider child scroll
   * horizontally instead of overflowing the sheet. Use when the body contains a
   * fixed-layout widget that forces its own min-width (e.g. the Monaco editor),
   * which otherwise pushes the body past the sheet edge and gets clipped. Ignored
   * when `noScroll` is set.
   */
  constrainBodyWidth?: boolean;
  children?: React.ReactNode;
}

export function SystemSheet({
  open,
  onOpenChange,
  crumb,
  name,
  meta,
  primaryAction,
  secondaryActions,
  destructiveAction,
  tabs,
  activeTab,
  onTabChange,
  footerContext,
  size = 'md',
  noScroll = false,
  constrainBodyWidth = false,
  children,
}: SystemSheetProps) {
  const hasToolbar = !!(primaryAction || (secondaryActions && secondaryActions.length > 0) || destructiveAction);
  const hasTabs = !!(tabs && tabs.length > 0);
  const hasFooter = footerContext !== undefined && footerContext !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showClose={false}
        className={cn(
          'w-full p-0 flex flex-col gap-0 border-glass-border',
          SIZE_CLASS[size],
        )}
      >
        <SheetDescription className="sr-only">{crumb.join(' › ')}</SheetDescription>

        <SheetHeaderBand
          crumb={crumb}
          name={name}
          meta={meta}
          onDismiss={() => onOpenChange(false)}
        />

        {hasToolbar && (
          <ToolbarBand
            primary={primaryAction}
            secondaries={secondaryActions}
            destructive={destructiveAction}
          />
        )}

        {hasTabs && (
          <TabsBand
            tabs={tabs}
            activeTab={activeTab ?? tabs[0].id}
            onTabChange={onTabChange}
          />
        )}

        {noScroll ? (
          <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        ) : (
          <ScrollArea className="flex-1" block={constrainBodyWidth}>
            <div className="px-6 py-5">{children}</div>
          </ScrollArea>
        )}

        {hasFooter && <FooterBand context={footerContext} />}
      </SheetContent>
    </Sheet>
  );
}

interface SheetHeaderBandProps {
  crumb: string[];
  name: React.ReactNode;
  meta?: React.ReactNode;
  onDismiss: () => void;
}

function SheetHeaderBand({ crumb, name, meta, onDismiss }: SheetHeaderBandProps) {
  const lastIdx = crumb.length - 1;
  return (
    <div className="relative bg-popover/95 backdrop-blur-md border-b border-card-border/60 px-6 pt-5 pb-4 pr-14">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-brand" />

      <nav aria-label="Sheet location" className={cn(CRUMB_CLASS, 'flex items-center gap-1.5 leading-none')}>
        {crumb.map((segment, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === lastIdx;
          return (
            <React.Fragment key={`${segment}-${idx}`}>
              {isFirst ? (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="hover:text-stat-value transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50 rounded-sm"
                >
                  {segment}
                </button>
              ) : (
                <span className={cn(isLast && 'text-stat-value')}>{segment}</span>
              )}
              {!isLast && <span aria-hidden className="text-stat-subtitle/60">›</span>}
            </React.Fragment>
          );
        })}
      </nav>

      <SheetTitle className="mt-2 font-heading text-[1.5rem] leading-tight text-stat-value text-left">
        {name}
      </SheetTitle>

      {meta && (
        <div className="mt-1.5 font-mono text-xs text-stat-subtitle tabular-nums">{meta}</div>
      )}

      <CloseSlot onDismiss={onDismiss} />
    </div>
  );
}

function CloseSlot({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="absolute right-4 top-4 flex items-center gap-1.5">
      <span
        aria-hidden
        className="font-mono text-[9px] tracking-[0.18em] uppercase border border-card-border rounded px-1.5 py-0.5 text-stat-subtitle leading-none"
      >
        ESC
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Close"
        className="inline-flex items-center justify-center h-6 w-6 rounded-sm text-stat-subtitle hover:text-stat-value hover:bg-glass-highlight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}

interface ToolbarBandProps {
  primary?: SystemSheetAction;
  secondaries?: SystemSheetAction[];
  destructive?: SystemSheetAction;
}

function ToolbarBand({ primary, secondaries, destructive }: ToolbarBandProps) {
  return (
    <div className="bg-popover/95 backdrop-blur-md flex items-center gap-2 border-b border-card-border/60 px-6 py-3">
      {primary && (
        <Button size="sm" onClick={primary.onClick} disabled={primary.disabled} className="gap-1.5">
          {primary.icon && <primary.icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {primary.label}
        </Button>
      )}
      {secondaries?.map((action, idx) => (
        <Button
          key={idx}
          size="sm"
          variant="outline"
          onClick={action.onClick}
          disabled={action.disabled}
          className="gap-1.5"
        >
          {action.icon && <action.icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {action.label}
        </Button>
      ))}
      <span className="flex-1" />
      {destructive && (
        <Button
          size="sm"
          variant="ghost"
          onClick={destructive.onClick}
          disabled={destructive.disabled}
          className="gap-1.5 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
        >
          {destructive.icon && <destructive.icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {destructive.label}
        </Button>
      )}
    </div>
  );
}

interface TabsBandProps {
  tabs: SystemSheetTab[];
  activeTab: string;
  onTabChange?: (id: string) => void;
}

function TabsBand({ tabs, activeTab, onTabChange }: TabsBandProps) {
  return (
    <div role="tablist" className="bg-popover/95 backdrop-blur-md flex items-stretch gap-0 border-b border-card-border/60 px-4">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange?.(tab.id)}
            className={cn(
              'relative inline-flex items-center gap-1.5 px-3 py-2.5',
              'font-mono text-[10px] uppercase tracking-[0.18em] transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50',
              isActive ? 'text-stat-value' : 'text-stat-subtitle hover:text-stat-value',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">{tab.count}</span>
            )}
            {isActive && (
              <span aria-hidden className="pointer-events-none absolute inset-x-2 -bottom-px h-[2px] bg-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function FooterBand({ context }: { context: React.ReactNode }) {
  return (
    <div className="bg-popover/95 backdrop-blur-md border-t border-card-border/60 px-6 py-3">
      <div className={cn(KICKER_CLASS, 'text-stat-subtitle leading-none')}>{context}</div>
    </div>
  );
}

export interface SheetSectionProps {
  title: string;
  /** Hide the title rule + label (useful when a section is the only one in a tab). */
  hideHeader?: boolean;
  /** Optional right-aligned mono meta on the section header row (count, scope, freshness). */
  meta?: string;
  className?: string;
  children: React.ReactNode;
}

export function SheetSection({ title, hideHeader, meta, className, children }: SheetSectionProps) {
  return (
    <section className={cn('first:pt-0 first:border-t-0 -mx-6 px-6 py-4 border-t border-card-border/40', className)}>
      {!hideHeader && (
        <div className="mb-3 flex items-baseline justify-between gap-3 leading-none">
          <h3 className={cn(KICKER_CLASS, 'text-stat-subtitle')}>{title}</h3>
          {meta && (
            <span className={cn(KICKER_CLASS, 'text-stat-subtitle/80 shrink-0')}>{meta}</span>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
