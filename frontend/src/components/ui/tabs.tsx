import * as React from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cn } from '@/lib/utils';

import {
  Tabs,
  TabsHighlight,
  TabsHighlightItem,
  TabsList as AnimateTabsList,
  TabsTrigger as AnimateTabsTrigger,
} from '@/components/animate-ui/primitives/radix/tabs';

const TabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof AnimateTabsList>
>(({ className, ...props }, ref) => (
  <AnimateTabsList
    ref={ref}
    className={cn(
      'inline-flex h-9 items-center justify-center rounded-lg bg-glass border border-glass-border p-1 text-muted-foreground',
      className
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof AnimateTabsTrigger>
>(({ className, ...props }, ref) => (
  <AnimateTabsTrigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow data-[state=active]:hover:bg-background',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

// Custom TabsContent: uses Radix directly (no Framer Motion `layout` prop)
// to prevent unintended height expansion when switching tabs.
const TabsContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof RadixTabs.Content>
>(({ className, ...props }, ref) => (
  <RadixTabs.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-200',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsHighlight, TabsHighlightItem };
