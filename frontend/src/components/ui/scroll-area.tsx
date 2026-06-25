import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    // Opt in when the viewport wraps content that manages its own horizontal
    // overflow (e.g., a child `overflow-x-auto` table). Overrides Radix's
    // default `display: table` wrapper so the child can be constrained to the
    // viewport width and trigger its own scroll. Also renders a horizontal
    // ScrollBar for viewports that overflow directly.
    block?: boolean;
    // Opt in to a horizontal ScrollBar while keeping Radix's default
    // content-sizing wrapper, so content wider than the viewport (e.g. a file
    // tree with long names) scrolls horizontally with the styled thumb. Unlike
    // `block`, this does not clamp the content to the viewport width.
    horizontal?: boolean;
  }
>(({ className, children, viewportRef, block, horizontal, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      ref={viewportRef}
      className={cn(
        "h-full w-full rounded-[inherit]",
        block && "[&>div]:!block [&>div]:!min-w-0"
      )}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation="vertical" />
    {(block || horizontal) && <ScrollBar orientation="horizontal" />}
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

// Thumb uses a translucent foreground alpha so it harmonizes with glass
// overlays (dropdowns, popovers, dialogs) instead of competing with content.
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors bg-transparent",
      orientation === "vertical" &&
        "h-full w-2 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
