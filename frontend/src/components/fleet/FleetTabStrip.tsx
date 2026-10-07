import { useEffect, useRef, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { ScrollableTabRow } from '@/components/ui/ScrollableTabRow';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { springs } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { FleetTab } from '@/lib/events';
import type { FleetTabLayout } from '@/hooks/use-fleet-tab-layout';
import { COMPACT_PRIMARY_TABS, type FleetTabItem } from './fleetTabs';

interface FleetTabStripProps {
  layout: FleetTabLayout;
  tabs: readonly FleetTabItem[];
  active: FleetTab;
  onChange: (tab: FleetTab) => void;
}

const LIST_CLASS = 'border-transparent bg-transparent';

function TabItem({ tab }: { tab: FleetTabItem }) {
  const Icon = tab.icon;
  return (
    <TabsHighlightItem value={tab.value}>
      <TabsTrigger value={tab.value}>
        {Icon && <Icon className="w-4 h-4 mr-1.5" />}{tab.label}
      </TabsTrigger>
    </TabsHighlightItem>
  );
}

function Highlight({ children }: { children: ReactNode }) {
  return (
    <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
      {children}
    </TabsHighlight>
  );
}

/**
 * The Fleet tab strip in one of two layouts. Every layout drives the same
 * Radix tabs value, so deep links, URL sync and the tab content are identical;
 * only how the triggers are arranged differs.
 */
export function FleetTabStrip({ layout, tabs, active, onChange }: FleetTabStripProps) {
  if (layout === 'compact') {
    const visible = tabs.filter(t => COMPACT_PRIMARY_TABS.includes(t.value));
    const more = tabs.filter(t => !COMPACT_PRIMARY_TABS.includes(t.value));
    const moreActive = more.find(t => t.value === active);
    return (
      <div className="flex items-center gap-1 min-w-0">
        <TabsList className={cn(LIST_CLASS, 'max-md:overflow-x-auto max-md:[scrollbar-width:none]')}>
          <Highlight>
            {visible.map(tab => <TabItem key={tab.value} tab={tab} />)}
          </Highlight>
        </TabsList>
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={moreActive ? `More tabs, ${moreActive.label} selected` : 'More tabs'}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
                  moreActive ? 'bg-brand/20 text-foreground' : 'text-muted-foreground',
                )}
              >
                {moreActive ? moreActive.label : 'More'}
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {more.map(tab => {
                const Icon = tab.icon;
                return (
                  <DropdownMenuItem
                    key={tab.value}
                    aria-current={tab.value === active ? 'true' : undefined}
                    onSelect={() => onChange(tab.value)}
                  >
                    {Icon && <Icon className="w-4 h-4 mr-2" />}{tab.label}
                    {tab.value === active && <Check className="w-3.5 h-3.5 ml-auto" aria-hidden />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  return <FlatStrip tabs={tabs} active={active} />;
}

/**
 * Flat layout: every tab on one row, the monitoring tabs, a vertical separator,
 * then the tabs that change the fleet. The row scrolls sideways when the window
 * is too narrow, and the active tab is kept in view, since a deep link can land
 * on one the row has scrolled past.
 */
function FlatStrip({ tabs, active }: { tabs: readonly FleetTabItem[]; active: FleetTab }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [active]);
  const observe = tabs.filter(t => t.group === 'observe');
  const operate = tabs.filter(t => t.group === 'operate');
  return (
    <div ref={ref} className="min-w-0 flex-1">
      <ScrollableTabRow surface="card">
        <TabsList className={cn(LIST_CLASS, 'w-max items-center')}>
          <Highlight>
            {observe.map(tab => <TabItem key={tab.value} tab={tab} />)}
            {operate.length > 0 && (
              <>
                <span aria-hidden className="self-center mx-2 h-4 w-px bg-border" />
                {operate.map(tab => <TabItem key={tab.value} tab={tab} />)}
              </>
            )}
          </Highlight>
        </TabsList>
      </ScrollableTabRow>
    </div>
  );
}
