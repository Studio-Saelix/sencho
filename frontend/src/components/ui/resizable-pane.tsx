import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { PaneWidthBounds } from '@/hooks/use-pane-layout-preference';

export interface ResizablePaneConfig {
  side: 'start' | 'end';
  bounds: PaneWidthBounds;
  minComplementWidth: number;
  separatorSize: number;
  boundsFootprint: number;
  keyboardStep: number;
  label: string;
  testId: string;
  paneClassName?: string;
  separatorClassName?: string;
}

interface ResizablePaneProps {
  width: number;
  onCommitWidth: (width: number) => void;
  config: ResizablePaneConfig;
  children: ReactNode;
}

export function ResizablePane({ width, onCommitWidth, config, children }: ResizablePaneProps) {
  const paneId = useId();
  const paneRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; lastWidth: number } | null>(null);

  useEffect(() => {
    const el = paneRef.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setContainerWidth(rect.width);
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth !== undefined && nextWidth > 0) setContainerWidth(nextWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const effectiveMax = containerWidth > 0
    ? Math.floor(Math.max(config.bounds.min, Math.min(
        config.bounds.max,
        containerWidth - config.minComplementWidth - config.boundsFootprint,
      )))
    : config.bounds.max;
  const sanitizedWidth = Number.isInteger(width)
    ? Math.min(config.bounds.max, Math.max(config.bounds.min, width))
    : config.bounds.default;
  const effectiveWidth = Math.min(effectiveMax, Math.max(config.bounds.min, sanitizedWidth));

  const applyPaneWidth = useCallback((nextWidth: number): void => {
    if (paneRef.current) paneRef.current.style.width = `${nextWidth}px`;
  }, []);

  const endDrag = useCallback((): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      if (drag !== null && separatorRef.current?.hasPointerCapture?.(drag.pointerId)) {
        separatorRef.current.releasePointerCapture(drag.pointerId);
      }
    } finally {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
    }
  }, []);

  useEffect(() => () => endDrag(), [endDrag]);
  useEffect(() => {
    if (!dragging) applyPaneWidth(effectiveWidth);
  }, [applyPaneWidth, dragging, effectiveWidth]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current !== null) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: effectiveWidth, lastWidth: effectiveWidth };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [effectiveWidth]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const direction = config.side === 'start' ? 1 : -1;
    const rawWidth = drag.startWidth + direction * (event.clientX - drag.startX);
    const nextWidth = Math.min(effectiveMax, Math.max(config.bounds.min, rawWidth));
    drag.lastWidth = nextWidth;
    applyPaneWidth(nextWidth);
  }, [applyPaneWidth, config.bounds.min, config.side, effectiveMax]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    try {
      onCommitWidth(Math.round(drag.lastWidth));
    } finally {
      endDrag();
    }
  }, [endDrag, onCommitWidth]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'Home') nextWidth = config.bounds.min;
    if (event.key === 'End') nextWidth = effectiveMax;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const visualDirection = event.key === 'ArrowRight' ? 1 : -1;
      const paneDirection = config.side === 'start' ? visualDirection : -visualDirection;
      nextWidth = Math.min(effectiveMax, Math.max(
        config.bounds.min,
        effectiveWidth + paneDirection * config.keyboardStep,
      ));
    }
    if (nextWidth === null) return;
    event.preventDefault();
    applyPaneWidth(nextWidth);
    onCommitWidth(nextWidth);
  }, [applyPaneWidth, config.bounds.min, config.keyboardStep, config.side, effectiveMax, effectiveWidth, onCommitWidth]);

  const pane = (
    <div ref={paneRef} id={paneId} data-testid={`${config.testId}-pane`} className={config.paneClassName} style={{ width: effectiveWidth }}>
      {children}
    </div>
  );
  const separator = (
    <div
      ref={separatorRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={config.label}
      aria-controls={paneId}
      aria-valuenow={effectiveWidth}
      aria-valuemin={config.bounds.min}
      aria-valuemax={effectiveMax}
      aria-valuetext={`${effectiveWidth} pixels`}
      tabIndex={0}
      data-testid={`${config.testId}-separator`}
      className={config.separatorClassName}
      style={{ width: config.separatorSize }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    >
      <span
        className="absolute inset-y-0 left-1/2 -translate-x-1/2"
        style={{ width: config.boundsFootprint }}
        aria-hidden
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-glass-border transition-colors group-hover:bg-brand group-focus-visible:bg-brand" />
      </span>
    </div>
  );

  return config.side === 'start' ? <>{pane}{separator}</> : <>{separator}{pane}</>;
}
