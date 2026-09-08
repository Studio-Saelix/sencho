/**
 * Coverage for SidebarResizePane, the desktop sidebar resize boundary.
 *
 * The pane owns the width: dragging writes the pane style directly (no React
 * state per move) and only a pointerup commits a preference write; every
 * cancellation path (pointercancel, lost capture, unmount) cleans the body
 * styles without committing. A ResizeObserver on the shell flex row drives
 * the effective bounds so a narrow window clamps live without rewriting the
 * stored width.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarResizePane } from '../SidebarResizePane';
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_KEY, useSidebarLayout } from '@/hooks/use-sidebar-layout';
import { subscribeToPreferenceWrites } from '@/lib/preferences/preferenceEvents';

const OriginalResizeObserver = globalThis.ResizeObserver;
const observed: { el: Element; cb: ResizeObserverCallback }[] = [];
let shellRowWidth = 0;

function shellRowRect(width: number): DOMRect {
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

function notifyShellRowResize(): void {
  for (const { el, cb } of [...observed]) {
    cb(
      [{
        target: el,
        contentRect: el.getBoundingClientRect(),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }
}

function pane(): HTMLElement {
  return screen.getByTestId('sidebar-resize-pane');
}

function separator(): HTMLElement {
  return screen.getByRole('separator', { name: 'Resize stacks sidebar' });
}

function dragSeparator(fromX: number, toX: number): void {
  const sep = separator();
  fireEvent.pointerDown(sep, { pointerId: 1, clientX: fromX });
  fireEvent.pointerMove(sep, { pointerId: 1, clientX: toX });
  fireEvent.pointerUp(sep, { pointerId: 1, clientX: toX });
}

// Harness mirroring the real wiring: width state comes from the shared
// preference hook, so a commit lands in localStorage and notifies the bus
// exactly like the shell does.
function Harness({ onCommit }: { onCommit?: (w: number) => void }) {
  const { sidebarWidth, setSidebarWidth } = useSidebarLayout();
  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <SidebarResizePane
        sidebarWidth={sidebarWidth}
        onCommitWidth={(w) => { setSidebarWidth(w); onCommit?.(w); }}
      >
        <div data-testid="sidebar-content">sidebar</div>
      </SidebarResizePane>
      <div data-testid="workspace">workspace</div>
    </div>
  );
}

function setup(onCommit?: (w: number) => void) {
  return render(<Harness onCommit={onCommit} />);
}

describe('SidebarResizePane', () => {
  beforeEach(() => {
    localStorage.clear();
    observed.length = 0;
    shellRowWidth = 1200;
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // The pane's parent is the shell flex row (pane + separator + workspace).
      if (this.querySelector?.('[data-testid="workspace"]')) return shellRowRect(shellRowWidth);
      return origRect.call(this);
    });
    globalThis.ResizeObserver = class MockShellRowResizeObserver {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observed.push({ el, cb: this.cb });
        this.cb(
          [{
            target: el,
            contentRect: el.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    vi.restoreAllMocks();
  });

  it('applies the preferred width on mount and renders the separator with live ARIA bounds', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '320');
    setup();
    await waitFor(() => {
      expect(pane().style.width).toBe('320px');
      expect(separator()).toHaveAttribute('aria-valuenow', '320');
      expect(separator()).toHaveAttribute('aria-valuemin', String(SIDEBAR_WIDTH.min));
      expect(separator()).toHaveAttribute('aria-valuemax', String(SIDEBAR_WIDTH.max));
    });
  });

  it('clamps the live drag to the viewport bound without rewriting storage', async () => {
    shellRowWidth = 900; // effectiveMax = 900 - 560 - 12 = 328
    const commits: number[] = [];
    setup((w) => commits.push(w));
    await waitFor(() => expect(separator()).toHaveAttribute('aria-valuemax', '328'));
    dragSeparator(300, 900);
    expect(pane().style.width).toBe('328px');
    expect(commits).toEqual([328]);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('328');
  });

  it('emits exactly one sanitized integer commit per drag', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '280');
    const commits: number[] = [];
    setup((w) => commits.push(w));
    const sep = separator();
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 321.6 }); // fractional pointer delta
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 332.2 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 332.2 });
    expect(commits).toEqual([312]);
    expect(Number.isInteger(commits[0])).toBe(true);
    expect(pane().style.width).toBe('312px');
  });

  it('writes pane style per move without any preference write until release', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '280');
    const notify = vi.fn();
    const unsub = subscribeToPreferenceWrites(notify);
    const commits: number[] = [];
    setup((w) => commits.push(w));
    const sep = separator();
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 380 });
    expect(pane().style.width).toBe('360px');
    expect(commits).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 380 });
    expect(commits).toEqual([360]);
    expect(notify).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('tears down on pointercancel without committing and restores the effective width', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '280');
    const commits: number[] = [];
    setup((w) => commits.push(w));
    const sep = separator();
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 380 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerCancel(sep, { pointerId: 1, clientX: 0 });
    expect(commits).toEqual([]);
    expect(pane().style.width).toBe('280px');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 500 });
    expect(commits).toEqual([]);
  });

  it('finishes on lostpointercapture without committing and ignores a trailing one after pointerup', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '280');
    const commits: number[] = [];
    setup((w) => commits.push(w));
    const sep = separator();
    // Unexpected capture loss mid-drag: no commit.
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 380 });
    fireEvent.lostPointerCapture(sep, { pointerId: 1, clientX: 0 });
    expect(commits).toEqual([]);
    expect(pane().style.width).toBe('280px');
    expect(document.body.style.cursor).toBe('');
    // Committed pointerup, then the browser's trailing lostpointercapture.
    dragSeparator(300, 340);
    fireEvent.lostPointerCapture(sep, { pointerId: 1, clientX: 0 });
    expect(commits).toEqual([320]);
    expect(pane().style.width).toBe('320px');
  });

  it('clears body resize styles if the pane unmounts mid-drag', async () => {
    const { unmount } = setup();
    fireEvent.pointerDown(separator(), { pointerId: 1, clientX: 300 });
    expect(document.body.style.cursor).toBe('col-resize');
    unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('shrinks the live pane on a narrow shell without rewriting storage, then restores on widen', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
    shellRowWidth = 900; // effectiveMax = 328
    const commits: number[] = [];
    setup((w) => commits.push(w));
    await waitFor(() => expect(pane().style.width).toBe('328px'));
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400');
    shellRowWidth = 1200;
    act(() => { notifyShellRowResize(); });
    await waitFor(() => expect(pane().style.width).toBe('400px'));
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400');
    expect(commits).toEqual([]);
  });

  it('commits Home/End and arrow-key widths and updates ARIA live', async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
    const user = userEvent.setup();
    const commits: number[] = [];
    shellRowWidth = 1200;
    setup((w) => commits.push(w));
    separator().focus();
    await user.keyboard('{ArrowRight}');
    expect(commits).toEqual([316]);
    expect(separator()).toHaveAttribute('aria-valuenow', '316');
    await user.keyboard('{Home}');
    expect(pane().style.width).toBe(`${SIDEBAR_WIDTH.min}px`);
    await user.keyboard('{End}');
    expect(pane().style.width).toBe(`${SIDEBAR_WIDTH.max}px`);
    expect(separator()).toHaveAttribute('aria-valuemax', String(SIDEBAR_WIDTH.max));
    expect(commits).toEqual([316, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max]);
  });
});
