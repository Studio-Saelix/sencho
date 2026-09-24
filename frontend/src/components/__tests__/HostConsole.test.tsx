import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as NodeContext from '@/context/NodeContext';
import HostConsole from '../HostConsole';

vi.mock('@/context/NodeContext');

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

vi.mock('@/lib/xtermLoader', () => {
  class FakeTerminal {
    static lastOptions: Record<string, unknown> | undefined;
    static lastInstance: FakeTerminal | undefined;
    constructor(options?: Record<string, unknown>) {
      FakeTerminal.lastOptions = options;
      FakeTerminal.lastInstance = this;
    }
    cols = 80;
    rows = 24;
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    clear = vi.fn();
    dispose = vi.fn();
    getSelection = vi.fn(() => '');
    hasSelection = vi.fn(() => false);
    clearSelection = vi.fn();
    paste = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
  }
  class FakeFitAddon {
    fit = vi.fn();
  }
  class FakeSerializeAddon {
    serialize = vi.fn(() => '');
  }
  return {
    loadXtermModules: async () => ({
      Terminal: FakeTerminal,
      FitAddon: FakeFitAddon,
      SerializeAddon: FakeSerializeAddon,
    }),
  };
});

vi.mock('../ui/PageMasthead', () => ({
  PageMasthead: ({ children }: { children?: ReactNode }) => <div data-testid="masthead">{children}</div>,
}));

vi.mock('../ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>{children}</button>
  ),
}));

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => undefined),
}));

type FakeWs = {
  url: string;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
};

describe('HostConsole socket targeting', () => {
  const sockets: FakeWs[] = [];
  let OriginalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    OriginalWebSocket = globalThis.WebSocket;
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 1, name: 'Local', type: 'local' },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);

    globalThis.WebSocket = class {
      static OPEN = 1;
      static CLOSED = 3;
      url: string;
      readyState = 0;
      close = vi.fn(() => { this.readyState = 3; });
      send = vi.fn();
      onopen: FakeWs['onopen'] = null;
      onmessage: FakeWs['onmessage'] = null;
      onerror: FakeWs['onerror'] = null;
      onclose: FakeWs['onclose'] = null;
      constructor(url: string) {
        this.url = url;
        sockets.push(this as unknown as FakeWs);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(undefined);
        });
      }
    } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    else delete (window as { isSecureContext?: boolean }).isSecureContext;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
    localStorage.removeItem('sencho-active-node');
    vi.clearAllMocks();
  });

  it('opens the WebSocket with the explicit nodeId (not localStorage)', async () => {
    localStorage.setItem('sencho-active-node', '99');
    render(<HostConsole nodeId={7} stackName={null} onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0].url).toContain('nodeId=7');
    expect(sockets[0].url).not.toContain('nodeId=99');
  });

  it('disables right-click word selection so right-click can paste on macOS', async () => {
    const { loadXtermModules } = await import('@/lib/xtermLoader');
    const { Terminal } = await loadXtermModules();
    render(<HostConsole nodeId={1} stackName={null} onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    expect((Terminal as unknown as { lastOptions?: Record<string, unknown> }).lastOptions)
      .toMatchObject({ rightClickSelectsWord: false });
  });

  it('pastes on right-click and stops listening after unmount', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    const readText = vi.fn(async () => 'ls');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    const { loadXtermModules } = await import('@/lib/xtermLoader');
    const { Terminal } = await loadXtermModules();
    type Fake = { open: ReturnType<typeof vi.fn>; paste: ReturnType<typeof vi.fn> };
    const fake = () => (Terminal as unknown as { lastInstance?: Fake }).lastInstance;

    const { unmount } = render(<HostConsole nodeId={1} stackName={null} onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    const term = fake()!;
    const container = term.open.mock.calls[0][0] as HTMLElement;

    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith('ls'));

    unmount();
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('includes the stack parameter when provided', async () => {
    render(<HostConsole nodeId={1} stackName="radarr" onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0].url).toContain('stack=radarr');
  });

  it('closes the prior socket and opens a new one when nodeId changes', async () => {
    const { rerender } = render(<HostConsole nodeId={1} stackName={null} onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    const first = sockets[0];

    await act(async () => {
      rerender(<HostConsole nodeId={2} stackName={null} onClose={vi.fn()} />);
    });
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(first.close).toHaveBeenCalled();
    expect(sockets[1].url).toContain('nodeId=2');
  });

  it('reconnects when stackName changes so a root shell is not retained', async () => {
    const { rerender } = render(<HostConsole nodeId={1} stackName={null} onClose={vi.fn()} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    const first = sockets[0];
    expect(first.url).not.toContain('stack=');

    await act(async () => {
      rerender(<HostConsole nodeId={1} stackName="radarr" onClose={vi.fn()} />);
    });
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(first.close).toHaveBeenCalled();
    expect(sockets[1].url).toContain('stack=radarr');
  });
});
