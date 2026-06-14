import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// Horizontal scroller for a row of tabs/chips that overflows its width. When the
// row overflows, a fade + a clickable chevron appears on the overflowing edge
// (a row that fits looks unchanged); a vertical mouse wheel over the row is
// translated into horizontal scroll. This is the one place the fade + arrow
// affordance lives, so every tab strip (stack anatomy, the mobile page tabs)
// reads and behaves the same.
interface ScrollableTabRowProps {
  children: ReactNode;
  /** Surface the row sits on, so the edge fade blends into it. */
  surface?: 'card' | 'background';
  /** Applied to the scroll viewport (e.g. a border-b that should span full width). */
  className?: string;
  /** Applied to the relative wrapper (e.g. `min-w-0 flex-1` inside a flex row). */
  wrapperClassName?: string;
}

const FADE: Record<'card' | 'background', { left: string; right: string }> = {
  card: {
    left: 'from-card via-card/90 to-transparent',
    right: 'from-card via-card/90 to-transparent',
  },
  background: {
    left: 'from-background via-background/90 to-transparent',
    right: 'from-background via-background/90 to-transparent',
  },
};

export function ScrollableTabRow({ children, surface = 'card', className, wrapperClassName }: ScrollableTabRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback((el: HTMLElement) => {
    const left = el.scrollLeft > 1;
    const right = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth;
    // Bail when unchanged so the per-render measure effect cannot loop (a fresh
    // object every render would re-trigger the effect forever).
    setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  const scrollBy = useCallback((direction: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: direction * Math.max(96, el.clientWidth * 0.7), behavior: 'smooth' });
  }, []);

  // Re-measure after every render so a changed tab set (or width) updates the
  // arrows; cheap and avoids threading the row's contents through a dep array.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) measure(el);
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Non-passive so preventDefault works: turn a vertical wheel into horizontal
    // scroll only when the row overflows (trackpads already scroll horizontally).
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure(el)) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('wheel', onWheel); ro?.disconnect(); };
  }, [measure]);

  const fade = FADE[surface];
  return (
    <div className={cn('relative', wrapperClassName)}>
      <div
        ref={scrollRef}
        onScroll={e => measure(e.currentTarget)}
        className={cn('overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
      >
        {children}
      </div>
      {edges.left && (
        <button
          type="button"
          aria-label="Scroll tabs left"
          data-testid="tab-scroll-left"
          onClick={() => scrollBy(-1)}
          className={cn('absolute inset-y-0 left-0 flex w-7 items-center justify-start bg-gradient-to-r text-stat-subtitle transition-colors hover:text-brand', fade.left)}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </button>
      )}
      {edges.right && (
        <button
          type="button"
          aria-label="Scroll tabs right"
          data-testid="tab-scroll-right"
          onClick={() => scrollBy(1)}
          className={cn('absolute inset-y-0 right-0 flex w-7 items-center justify-end bg-gradient-to-l text-stat-subtitle transition-colors hover:text-brand', fade.right)}
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
