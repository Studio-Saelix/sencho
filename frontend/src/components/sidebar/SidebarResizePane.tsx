import type { ReactNode } from 'react';
import { SIDEBAR_WIDTH } from '@/hooks/use-sidebar-layout';
import { ResizablePane, type ResizablePaneConfig } from '@/components/ui/resizable-pane';

const SIDEBAR_RESIZE_CONFIG: ResizablePaneConfig = {
  side: 'start',
  bounds: SIDEBAR_WIDTH,
  minComplementWidth: 560,
  separatorSize: 1,
  boundsFootprint: 12,
  keyboardStep: 8,
  label: 'Resize stacks sidebar',
  testId: 'sidebar-resize',
  paneClassName: 'h-full shrink-0 min-w-0 overflow-hidden',
  separatorClassName: 'group relative z-10 shrink-0 cursor-col-resize touch-none outline-none focus-visible:ring-1 focus-visible:ring-brand/50',
};

interface SidebarResizePaneProps {
  sidebarWidth: number;
  onCommitWidth: (width: number) => void;
  children: ReactNode;
}

export function SidebarResizePane({ sidebarWidth, onCommitWidth, children }: SidebarResizePaneProps) {
  return (
    <ResizablePane width={sidebarWidth} onCommitWidth={onCommitWidth} config={SIDEBAR_RESIZE_CONFIG}>
      {children}
    </ResizablePane>
  );
}
