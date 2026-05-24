import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useContainerStats } from './useContainerStats';
import type { ContainerInfo } from '../EditorView';

class MockWS {
  static instances: MockWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  constructor() { MockWS.instances.push(this); }
  static reset() { MockWS.instances = []; }
}

const makeContainer = (id: string): ContainerInfo =>
  ({ Id: id, Names: [`/${id}`], State: 'running', Status: 'Up 1 minute', Image: 'img' } as ContainerInfo);

beforeEach(() => {
  MockWS.reset();
  vi.stubGlobal('WebSocket', MockWS);
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => ''), setItem: vi.fn(), clear: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useContainerStats', () => {
  it('returns empty stats for empty containers', () => {
    const { result } = renderHook(() => useContainerStats([], 1));
    expect(result.current.stats).toEqual({});
    expect(result.current.error).toBeNull();
  });

  it('opens one WebSocket per container', () => {
    renderHook(() => useContainerStats([makeContainer('abc'), makeContainer('def')], 1));
    expect(MockWS.instances).toHaveLength(2);
  });

  it('sends streamStats action on WS open', () => {
    renderHook(() => useContainerStats([makeContainer('abc')], 1));
    act(() => { MockWS.instances[0]?.onopen?.(); });
    expect(MockWS.instances[0].send).toHaveBeenCalledWith(
      expect.stringContaining('"action":"streamStats"'),
    );
  });

  it('flushes buffered stats into state after 1500ms', () => {
    const { result } = renderHook(() => useContainerStats([makeContainer('c1')], 1));
    act(() => { MockWS.instances[0]?.onopen?.(); });

    const statsMsg = {
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1048576 },
      networks: { eth0: { rx_bytes: 1024, tx_bytes: 512 } },
    };
    act(() => { MockWS.instances[0]?.onmessage?.({ data: JSON.stringify(statsMsg) }); });

    expect(result.current.stats['c1']).toBeUndefined();

    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current.stats['c1']).toBeDefined();
    expect(result.current.stats['c1'].cpu).toContain('%');
    expect(result.current.stats['c1'].ram).toContain('MB');
  });

  it('closes all WebSockets when containers change', () => {
    const { rerender } = renderHook(
      ({ containers, nodeId }: { containers: ContainerInfo[]; nodeId: number }) =>
        useContainerStats(containers, nodeId),
      { initialProps: { containers: [makeContainer('old')], nodeId: 1 } },
    );
    const firstWs = MockWS.instances[0];
    rerender({ containers: [makeContainer('new')], nodeId: 1 });
    expect(firstWs.close).toHaveBeenCalled();
  });

  it('reopens WebSockets when activeNodeId changes', () => {
    const { rerender } = renderHook(
      ({ containers, nodeId }: { containers: ContainerInfo[]; nodeId: number }) =>
        useContainerStats(containers, nodeId),
      { initialProps: { containers: [makeContainer('abc')], nodeId: 1 } },
    );
    const firstWs = MockWS.instances[0];
    rerender({ containers: [makeContainer('abc')], nodeId: 2 });
    expect(firstWs.close).toHaveBeenCalled();
    expect(MockWS.instances).toHaveLength(2);
  });

  // These two cases run with real timers so React's scheduler can commit the
  // setError call triggered from inside the WebSocket onclose handler.
  it('warns on abnormal WebSocket close (code 1006)', () => {
    vi.useRealTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => useContainerStats([makeContainer('c1')], 1));
    act(() => { MockWS.instances[0]?.onclose?.({ code: 1006 } as CloseEvent); });
    expect(warnSpy).toHaveBeenCalledWith(
      '[useContainerStats] stats stream failure:',
      expect.objectContaining({ kind: 'ws-closed' }),
    );
    warnSpy.mockRestore();
  });

  it('does NOT warn on a normal close (code 1000)', () => {
    vi.useRealTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => useContainerStats([makeContainer('c1')], 1));
    act(() => { MockWS.instances[0]?.onclose?.({ code: 1000 } as CloseEvent); });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
