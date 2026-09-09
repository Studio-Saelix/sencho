import { useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnatomyResizePane } from '../AnatomyResizePane';
import { ANATOMY_WIDTH } from '@/hooks/use-anatomy-layout';

const OriginalResizeObserver = globalThis.ResizeObserver;
let observed: { el: Element; cb: ResizeObserverCallback } | null = null;
let containerWidth = 1200;

function rect(width: number): DOMRect {
  return {
    width,
    height: 800,
    top: 0,
    left: 0,
    bottom: 800,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function notifyResize(): void {
  if (!observed) return;
  observed.cb([{
    target: observed.el,
    contentRect: observed.el.getBoundingClientRect(),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  } as unknown as ResizeObserverEntry], {} as ResizeObserver);
}

function setup(onCommitWidth = vi.fn(), width: number = ANATOMY_WIDTH.default): void {
  const { container } = render(
    <div data-testid="stack-detail-grid">
      <div>stack status and logs</div>
      <AnatomyResizePane anatomyWidth={width} onCommitWidth={onCommitWidth}>
        <div>anatomy</div>
      </AnatomyResizePane>
    </div>,
  );
  const grid = container.querySelector('[data-testid="stack-detail-grid"]') as HTMLDivElement;
  grid.getBoundingClientRect = () => rect(containerWidth);
  act(() => notifyResize());
}

function StatefulHarness({ onCommit, children }: { onCommit: (width: number) => void; children: ReactNode }) {
  const [width, setWidth] = useState<number>(ANATOMY_WIDTH.default);
  return (
    <div data-testid="stack-detail-grid">
      <div>stack status and logs</div>
      <AnatomyResizePane
        anatomyWidth={width}
        onCommitWidth={(nextWidth) => {
          setWidth(nextWidth);
          onCommit(nextWidth);
        }}
      >
        {children}
      </AnatomyResizePane>
    </div>
  );
}

describe('AnatomyResizePane', () => {
  beforeEach(() => {
    observed = null;
    containerWidth = 1200;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      private cb: ResizeObserverCallback;
      observe(el: Element): void {
        observed = { el, cb: this.cb };
      }
      disconnect(): void {}
      unobserve(): void {}
    };
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('renders the preferred width and vertical separator semantics', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('anatomy-resize-pane')).toHaveStyle({ width: '640px' }));
    expect(screen.getByRole('separator', { name: 'Resize Anatomy panel' })).toHaveAttribute('aria-valuenow', '640');
  });

  it('dragging left widens the right-hand Anatomy pane and commits only on release', () => {
    const commit = vi.fn();
    setup(commit);
    const separator = screen.getByTestId('anatomy-resize-separator');

    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 620 });
    expect(screen.getByTestId('anatomy-resize-pane')).toHaveStyle({ width: '720px' });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 620 });
    expect(commit).toHaveBeenCalledWith(720);
  });

  it('keyboard direction follows the right-hand pane', async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const { container } = render(<StatefulHarness onCommit={commit}>anatomy</StatefulHarness>);
    const grid = container.querySelector('[data-testid="stack-detail-grid"]') as HTMLDivElement;
    grid.getBoundingClientRect = () => rect(containerWidth);
    act(() => notifyResize());
    screen.getByTestId('anatomy-resize-separator').focus();

    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{ArrowRight}');

    expect(commit.mock.calls).toEqual([[648], [640]]);
  });

  it('temporarily clamps to preserve the left pane without committing', async () => {
    const commit = vi.fn();
    containerWidth = 900;
    setup(commit, 1800);

    await waitFor(() => expect(screen.getByTestId('anatomy-resize-pane')).toHaveStyle({ width: '556px' }));
    expect(screen.getByTestId('anatomy-resize-separator')).toHaveAttribute('aria-valuemax', '556');
    expect(commit).not.toHaveBeenCalled();

    containerWidth = 2200;
    act(() => notifyResize());
    await waitFor(() => expect(screen.getByTestId('anatomy-resize-pane')).toHaveStyle({ width: '1800px' }));
    expect(commit).not.toHaveBeenCalled();
  });

  it('allows Anatomy to exceed 960px when the left pane still has 320px', async () => {
    containerWidth = 2200;
    setup(vi.fn(), 1800);

    await waitFor(() => expect(screen.getByTestId('anatomy-resize-pane')).toHaveStyle({ width: '1800px' }));
    expect(screen.getByTestId('anatomy-resize-separator')).toHaveAttribute('aria-valuemax', '1856');
  });
});
