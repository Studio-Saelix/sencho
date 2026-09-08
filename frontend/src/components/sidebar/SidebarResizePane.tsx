import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SIDEBAR_WIDTH, sanitizeSidebarWidth } from '@/hooks/use-sidebar-layout';

/**
 * Desktop sidebar resize boundary. Wraps the stacks sidebar in a width-owned
 * pane and renders the draggable separator beside it. This component is the
 * single resize owner: EditorLayout never holds drag state.
 *
 * Three widths stay separate: the preferred width (the persisted preference,
 * never mutated by the viewport), the in-flight live drag width, and the
 * effective width actually applied to the pane (preferred clamped to what the
 * viewport allows). Narrowing the window shrinks the pane live but does not
 * rewrite the preference; widening restores the preferred width.
 */

/** Workspace px reserved to the right of the sidebar before clamping bites. */
const MIN_WORKSPACE = 560;
/** Separator hit area in px between sidebar and workspace. */
const HANDLE_FOOTPRINT = 12;
/** Keyboard step per arrow press, in px. */
const KEY_STEP = 16;

interface SidebarResizePaneProps {
  sidebarWidth: number;
  onCommitWidth: (width: number) => void;
  children: ReactNode;
}

export function SidebarResizePane({ sidebarWidth, onCommitWidth, children }: SidebarResizePaneProps) {
  const paneId = useId();
  const paneRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    lastWidth: number;
    committed: boolean;
  } | null>(null);

  // The pane's flex row (its parent: sidebar pane + separator + workspace)
  // is the viewport proxy; measuring it avoids window.innerWidth.
  useEffect(() => {
    const el = paneRef.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setContainerWidth(rect.width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // effectiveMax floors the viewport-derived bound to an integer; at zero
  // (before the first measurement) the unclamped bounds apply.
  const effectiveMax = containerWidth > 0
    ? Math.floor(Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, containerWidth - MIN_WORKSPACE - HANDLE_FOOTPRINT)))
    : SIDEBAR_WIDTH.max;
  const effectiveMin = SIDEBAR_WIDTH.min;
  const effectiveWidth = Math.min(
    effectiveMax,
    Math.max(effectiveMin, sanitizeSidebarWidth(sidebarWidth)),
  );

  const applyPaneWidth = useCallback((width: number): void => {
    if (paneRef.current) paneRef.current.style.width = `${width}px`;
  }, []);

  // Centralized, idempotent teardown for every termination path. A trailing
  // lostpointercapture after a committed pointerup is a no-op because the
  // committed pointerup cleared dragRef first.
  const endDrag = useCallback((): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      if (drag !== null) paneRef.current?.releasePointerCapture(drag.pointerId);
    } catch {
      /* capture may already be released */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setDragging(false);
  }, []);

  // Unmount mid-drag still cleans the body styles.
  useEffect(() => () => endDrag(), [endDrag]);

  // The pane is declaratively owned except mid-drag, when pointermove writes
  // the style directly (no React state, so only the boundary moves).
  useEffect(() => {
    if (!dragging && paneRef.current) paneRef.current.style.width = `${effectiveWidth}px`;
  }, [effectiveWidth, dragging]);

  const onSeparatorPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore additional pointers while a drag is in progress (multi-touch,
    // stray second mouse button) so they cannot steal or corrupt the drag.
    if (event.button !== 0 || dragRef.current !== null) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: effectiveWidth,
      lastWidth: effectiveWidth,
      committed: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [effectiveWidth]);

  const onSeparatorPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const raw = drag.startWidth + (event.clientX - drag.startX);
    const next = Math.min(effectiveMax, Math.max(effectiveMin, raw));
    drag.lastWidth = next;
    applyPaneWidth(next);
  }, [effectiveMax, effectiveMin, applyPaneWidth]);

  const onSeparatorPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // Snapshot and mark committed BEFORE releasing capture so the trailing
    // lostpointercapture finds no drag and cleans up without a second commit.
    drag.committed = true;
    try {
      onCommitWidth(Math.round(drag.lastWidth));
    } finally {
      endDrag();
    }
  }, [endDrag, onCommitWidth]);

  const onSeparatorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'Home') {
      next = effectiveMin;
    } else if (event.key === 'End') {
      next = effectiveMax;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP;
      next = Math.min(effectiveMax, Math.max(effectiveMin, effectiveWidth + delta));
    }
    if (next === null) return;
    event.preventDefault();
    applyPaneWidth(next);
    onCommitWidth(next);
  }, [effectiveMax, effectiveMin, effectiveWidth, applyPaneWidth, onCommitWidth]);

  return (
    <>
      <div
        ref={paneRef}
        id={paneId}
        data-testid="sidebar-resize-pane"
        className="h-full shrink-0 min-w-0 overflow-hidden"
        style={{ width: effectiveWidth }}
      >
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize stacks sidebar"
        aria-controls={paneId}
        aria-valuenow={effectiveWidth}
        aria-valuemin={effectiveMin}
        aria-valuemax={effectiveMax}
        aria-valuetext={`${effectiveWidth} pixels`}
        tabIndex={0}
        data-testid="sidebar-resize-separator"
        className="relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-glass-border outline-none hover:bg-brand focus-visible:bg-brand focus-visible:ring-1 focus-visible:ring-brand/50"
        onPointerDown={onSeparatorPointerDown}
        onPointerMove={onSeparatorPointerMove}
        onPointerUp={onSeparatorPointerUp}
        onPointerCancel={() => endDrag()}
        onLostPointerCapture={() => endDrag()}
        onKeyDown={onSeparatorKeyDown}
      >
        <span className="absolute inset-y-0 left-0 -right-1.5 z-10" aria-hidden />
      </div>
    </>
  );
}
