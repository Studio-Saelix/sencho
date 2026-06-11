/**
 * Unit tests for TerminalComponent's WebSocket URL construction, specifically
 * that a captured `nodeId` prop binds the socket to that node (number, or null
 * for local) and that an absent prop falls back to the active node. This is the
 * progress-stream half of keeping a deploy bound to the node it started on.
 */
import { render, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real loader pulls the ~660 KB xterm chunk; stub it so init resolves
// synchronously with no-op terminal/addons and the socket is built immediately.
vi.mock('@/lib/xtermLoader', () => {
  class FakeTerminal {
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    write() {}
    dispose() {}
  }
  class FakeFit { fit() {} }
  class FakeSearch { findNext() {} findPrevious() {} }
  class FakeSerialize { serialize() { return ''; } }
  return {
    loadXtermModules: vi.fn().mockResolvedValue({
      Terminal: FakeTerminal,
      FitAddon: FakeFit,
      SearchAddon: FakeSearch,
      SerializeAddon: FakeSerialize,
    }),
  };
});
vi.mock('@/lib/terminalTheme', () => ({ buildXtermTheme: () => ({}) }));

import TerminalComponent from '../Terminal';

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
  localStorage.setItem('sencho-active-node', '9');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem('sencho-active-node');
  vi.clearAllMocks();
});

// Mount and resolve the socket URL. Init runs after a 50ms timer + the async
// loader, so poll until the socket is constructed rather than racing it.
async function urlFor(props: { nodeId?: number | null; stackName?: string }): Promise<string> {
  render(<TerminalComponent deploySessionId="sess-1" {...props} />);
  await waitFor(() => expect(MockWS.instances.length).toBeGreaterThan(0));
  return MockWS.instances[0].url;
}

describe('TerminalComponent WebSocket URL', () => {
  it('binds the generic stream to an explicit numeric nodeId, overriding the active node', async () => {
    const url = await urlFor({ nodeId: 7 });
    expect(url).toContain('/ws?nodeId=7');
  });

  it('omits the nodeId query when nodeId is null (local), even with an active node set', async () => {
    const url = await urlFor({ nodeId: null });
    expect(url).toMatch(/\/ws$/);
    expect(url).not.toContain('nodeId=');
  });

  it('falls back to the active node when no nodeId prop is given', async () => {
    const url = await urlFor({});
    expect(url).toContain('/ws?nodeId=9');
  });

  it('binds the stack-logs stream to the captured nodeId', async () => {
    const url = await urlFor({ nodeId: 7, stackName: 'web' });
    expect(url).toContain('/api/stacks/web/logs?nodeId=7');
  });

  it('omits the nodeId query on the stack-logs stream when nodeId is null', async () => {
    const url = await urlFor({ nodeId: null, stackName: 'web' });
    expect(url).toMatch(/\/api\/stacks\/web\/logs$/);
    expect(url).not.toContain('nodeId=');
  });

  it('falls back to the active node on the stack-logs stream when no nodeId prop is given', async () => {
    const url = await urlFor({ stackName: 'web' });
    expect(url).toContain('/api/stacks/web/logs?nodeId=9');
  });
});
