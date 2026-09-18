import type { ReactNode } from 'react';
import { ANATOMY_WIDTH } from '@/hooks/use-anatomy-layout';
import { ResizablePane, type ResizablePaneConfig } from '@/components/ui/resizable-pane';

const ANATOMY_RESIZE_CONFIG: ResizablePaneConfig = {
  side: 'end',
  bounds: ANATOMY_WIDTH,
  minComplementWidth: ANATOMY_WIDTH.min,
  separatorSize: 24,
  boundsFootprint: 24,
  keyboardStep: 8,
  label: 'Resize Anatomy panel',
  testId: 'anatomy-resize',
  paneClassName: 'h-full min-w-0 overflow-hidden max-lg:!w-full',
  separatorClassName: 'group relative z-10 shrink-0 cursor-col-resize touch-none outline-none max-lg:hidden focus-visible:ring-1 focus-visible:ring-brand/50',
};

interface AnatomyResizePaneProps {
  anatomyWidth: number;
  onCommitWidth: (width: number) => void;
  children: ReactNode;
}

export function AnatomyResizePane({ anatomyWidth, onCommitWidth, children }: AnatomyResizePaneProps) {
  return (
    <ResizablePane width={anatomyWidth} onCommitWidth={onCommitWidth} config={ANATOMY_RESIZE_CONFIG}>
      {children}
    </ResizablePane>
  );
}
