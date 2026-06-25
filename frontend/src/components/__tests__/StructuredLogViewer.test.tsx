/**
 * Unit tests for StructuredLogViewer's log-row lifecycle, specifically that
 * switching stacks clears the old stack's committed rows, closes the old
 * WebSocket, resets auto-follow, and preserves the level filter.
 */
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import StructuredLogViewer from '../StructuredLogViewer';

class MockWS {
  static instances: MockWS[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(url: string) { this.url = url; MockWS.instances.push(this); }
  static reset() { MockWS.instances = []; }
}

beforeEach(() => {
  MockWS.reset();
  vi.stubGlobal('WebSocket', MockWS);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  localStorage.setItem('sencho-active-node', '');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem('sencho-active-node');
  vi.clearAllMocks();
});

describe('StructuredLogViewer', () => {
  it('renders initial empty state and builds the correct WebSocket URL', () => {
    const { container } = render(<StructuredLogViewer stackName="test-stack" />);
    expect(container.textContent).toContain('Waiting for log output');
    expect(MockWS.instances).toHaveLength(1);
    expect(MockWS.instances[0].url).toContain('/api/stacks/test-stack/logs');
  });

  it('renders log lines with timestamp, level badge, and message', async () => {
    const { container } = render(<StructuredLogViewer stackName="test-stack" />);
    await act(async () => {
      MockWS.instances[0].onopen?.();
      MockWS.instances[0].onmessage?.({ data: '2025-01-01T12:00:00Z ERROR something-failed' });
    });

    expect(container.textContent).toContain('something-failed');
    // Level badge is lowercase in the DOM (CSS text-transform handles visual).
    expect(container.textContent).toContain('err');

    // Timestamp: computed in local time.
    const ts = new Date('2025-01-01T12:00:00Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedTs = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
    expect(container.textContent).toContain(expectedTs);
  });

  it('clears committed rows when the stack changes', async () => {
    const { rerender, container } = render(<StructuredLogViewer stackName="stack-a" />);
    await act(async () => {
      MockWS.instances[0].onopen?.();
      MockWS.instances[0].onmessage?.({ data: '2025-01-01T10:00:00Z INFO only-in-stack-a\n' });
    });

    expect(container.textContent).toContain('only-in-stack-a');

    rerender(<StructuredLogViewer stackName="stack-b" />);
    await act(async () => {
      MockWS.instances[1].onopen?.();
      MockWS.instances[1].onmessage?.({ data: '2025-01-01T11:00:00Z ERROR only-in-stack-b\n' });
    });

    expect(container.textContent).not.toContain('only-in-stack-a');
    expect(container.textContent).toContain('only-in-stack-b');
  });

  it('closes the old WebSocket on stack switch', () => {
    const { rerender } = render(<StructuredLogViewer stackName="stack-a" />);
    const oldWs = MockWS.instances[0];
    expect(oldWs.close).not.toHaveBeenCalled();

    rerender(<StructuredLogViewer stackName="stack-b" />);
    expect(oldWs.close).toHaveBeenCalled();
  });

  it('downloads only the current stack rows after a switch', async () => {
    let capturedBlob: Blob | null = null;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:fake';
      }),
      revokeObjectURL: vi.fn(),
    });

    const { rerender } = render(<StructuredLogViewer stackName="stack-a" />);
    await act(async () => {
      MockWS.instances[0].onopen?.();
      MockWS.instances[0].onmessage?.({ data: '2025-01-01T10:00:00Z INFO from-stack-a\n' });
    });

    rerender(<StructuredLogViewer stackName="stack-b" />);
    await act(async () => {
      MockWS.instances[1].onopen?.();
      MockWS.instances[1].onmessage?.({ data: '2025-01-01T11:00:00Z ERROR from-stack-b\n' });
    });

    const downloadBtn = screen.getByLabelText('Download logs');
    await userEvent.click(downloadBtn);

    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    expect(text).toContain('from-stack-b');
    expect(text).not.toContain('from-stack-a');
  });

  it('preserves the level filter across stack switches', async () => {
    const { rerender, container } = render(<StructuredLogViewer stackName="stack-a" />);

    // Click the "warn" filter button.
    await userEvent.click(screen.getByText('warn'));

    rerender(<StructuredLogViewer stackName="stack-b" />);
    await act(async () => {
      MockWS.instances[1].onopen?.();
      MockWS.instances[1].onmessage?.({
        data: '2025-01-01T10:00:00Z INFO should-be-hidden\n2025-01-01T11:00:00Z WARNING should-be-visible\n',
      });
    });

    expect(container.textContent).not.toContain('should-be-hidden');
    expect(container.textContent).toContain('should-be-visible');
  });

  it('resets auto-follow when the stack changes', async () => {
    const { rerender, container } = render(<StructuredLogViewer stackName="stack-a" />);
    await act(async () => {
      MockWS.instances[0].onopen?.();
    });

    const scrollContainer = document.querySelector('.overflow-y-auto') as HTMLElement;
    expect(scrollContainer).not.toBeNull();

    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 200 });
    scrollContainer.scrollTop = 100;
    await act(async () => {
      fireEvent.scroll(scrollContainer);
    });

    expect(container.textContent).toContain('resume follow');

    rerender(<StructuredLogViewer stackName="stack-b" />);
    await act(async () => {
      MockWS.instances[1].onopen?.();
    });

    expect(container.textContent).toContain('following');
  });

  it('strips .yml and .yaml suffixes from the WebSocket URL', () => {
    const { rerender } = render(<StructuredLogViewer stackName="my-stack.yml" />);
    expect(MockWS.instances[0].url).toContain('/api/stacks/my-stack/logs');
    expect(MockWS.instances[0].url).not.toContain('.yml');

    rerender(<StructuredLogViewer stackName="another-stack.yaml" />);
    expect(MockWS.instances[1].url).toContain('/api/stacks/another-stack/logs');
    expect(MockWS.instances[1].url).not.toContain('.yaml');
  });
});
