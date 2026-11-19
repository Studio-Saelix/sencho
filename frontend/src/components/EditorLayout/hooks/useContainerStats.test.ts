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

const makeContainer = (id: string, state = 'running'): ContainerInfo =>
  ({ Id: id, Names: [`/${id}`], State: state, Status: 'Up 1 minute', Image: 'img' } as ContainerInfo);

beforeEach(() => {
  MockWS.reset();
  vi.stubGlobal('WebSocket', MockWS);
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => ''), setItem: vi.fn(), clear: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
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
  // failure state set from inside the WebSocket onclose handler.
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

  it('drops a late sample from a torn-down socket', () => {
    const { result, rerender } = renderHook(
      ({ containers, nodeId }: { containers: ContainerInfo[]; nodeId: number }) =>
        useContainerStats(containers, nodeId),
      { initialProps: { containers: [makeContainer('c1')], nodeId: 1 } },
    );
    const oldWs = MockWS.instances[0];
    const { onmessage } = oldWs;
    rerender({ containers: [makeContainer('c2')], nodeId: 1 });

    const sample = {
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1048576 },
    };
    act(() => { onmessage?.({ data: JSON.stringify(sample) }); });
    act(() => { vi.advanceTimersByTime(1500); });

    expect(result.current.stats['c1']).toBeUndefined();
  });

  describe('stats warning lifecycle', () => {
    const validSample = JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1048576 },
    });
    const noMemorySample = JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: 200 } },
      precpu_stats: { cpu_usage: { total_usage: 100 } },
    });

    type Props = { containers: ContainerInfo[]; nodeId: number };
    const setup = (initial: ContainerInfo[], { fakeTimers = false } = {}) => {
      if (!fakeTimers) vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hook = renderHook(
        ({ containers, nodeId }: Props) => useContainerStats(containers, nodeId),
        { initialProps: { containers: initial, nodeId: 1 } as Props },
      );
      return { ...hook, warnSpy };
    };

    it('ignores the error and close events a cleanup close provokes on a connecting socket', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
      const oldWs = MockWS.instances[0];
      // Simulate a late error/close reaching the handlers captured before the
      // cleanup detached them; the disposed guard must ignore them.
      const { onerror, onclose } = oldWs;

      // Same container, new array: a leaked failure would flag a live container.
      rerender({ containers: [makeContainer('c1')], nodeId: 1 });
      act(() => {
        onerror?.();
        onclose?.({ code: 1006 } as CloseEvent);
      });

      expect(result.current.error).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('clears the warning when the same live socket delivers a valid sample', () => {
      const { result, warnSpy } = setup([makeContainer('c1')]);
      const ws = MockWS.instances[0];

      act(() => { ws.onerror?.(); });
      expect(result.current.error).toMatch(/unavailable/);

      act(() => { ws.onmessage?.({ data: validSample }); });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('clears the warning when a replacement socket for the same container delivers a sample', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onclose?.({ code: 1006 } as CloseEvent); });
      expect(result.current.error).toMatch(/unavailable/);

      rerender({ containers: [makeContainer('c1')], nodeId: 1 });
      expect(MockWS.instances).toHaveLength(2);
      act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });

      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('keeps the warning while another container in the stack is still failing', () => {
      const { result, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });

      expect(result.current.error).toMatch(/unavailable/);

      act(() => { MockWS.instances[0].onmessage?.({ data: validSample }); });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('does not carry the warning over to a different stack on the same node', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      expect(result.current.error).toMatch(/unavailable/);

      rerender({ containers: [makeContainer('c2')], nodeId: 1 });
      expect(result.current.error).toBeNull();

      // Back on the first stack: its discarded failure must not return before
      // the new socket reports anything.
      rerender({ containers: [makeContainer('c1')], nodeId: 1 });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('does not restore a failure for a container removed from the list and added back', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      expect(result.current.error).toMatch(/unavailable/);

      rerender({ containers: [makeContainer('c2')], nodeId: 1 });
      expect(result.current.error).toBeNull();

      rerender({ containers: [makeContainer('c1'), makeContainer('c2')], nodeId: 1 });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('does not clear and re-raise the warning when the list refreshes with the same containers', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onerror?.(); });

      rerender({ containers: [makeContainer('c1')], nodeId: 1 });
      expect(result.current.error).toMatch(/unavailable/);

      act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('does not clear the warning on a frame that is not a valid sample', () => {
      const { result, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      act(() => { MockWS.instances[0].onmessage?.({ data: noMemorySample }); });

      expect(result.current.error).toMatch(/unavailable/);
      warnSpy.mockRestore();
    });

    it('keeps the warning when a sibling is dropped from the list but another failing container stays', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      act(() => { MockWS.instances[1].onerror?.(); });

      rerender({ containers: [makeContainer('c2')], nodeId: 1 });
      expect(result.current.error).toMatch(/unavailable/);

      act(() => { MockWS.instances[2].onmessage?.({ data: validSample }); });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('raises a parse-error warning when the reader throws on a null network entry', () => {
      const { result, warnSpy } = setup([makeContainer('c1')]);
      const badNetworks = JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 1048576 },
        networks: { eth0: null },
      });
      act(() => { MockWS.instances[0].onmessage?.({ data: badNetworks }); });

      expect(result.current.error).toMatch(/unavailable/);
      expect(warnSpy).toHaveBeenCalledWith(
        '[useContainerStats] stats stream failure:',
        expect.objectContaining({ kind: 'parse-error' }),
      );
      warnSpy.mockRestore();
    });

    it('does not clear the warning on a frame that cannot be parsed', () => {
      const { result, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onerror?.(); });
      act(() => { MockWS.instances[0].onmessage?.({ data: '{not json' }); });

      expect(result.current.error).toMatch(/unavailable/);
      warnSpy.mockRestore();
    });

    it('does not pin the warning on a stopped container that cannot stream', () => {
      const { result, warnSpy } = setup([makeContainer('c1'), makeContainer('c2', 'exited')]);
      act(() => { MockWS.instances[1].onerror?.(); });
      expect(result.current.error).toBeNull();

      act(() => { MockWS.instances[0].onerror?.(); });
      expect(result.current.error).toMatch(/unavailable/);

      act(() => { MockWS.instances[0].onmessage?.({ data: validSample }); });
      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });

    describe('frames that cannot yield usable readings', () => {
      const frame = (over: Record<string, unknown> = {}) => ({
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 1048576 },
        networks: { eth0: { rx_bytes: 1024, tx_bytes: 512 } },
        ...over,
      });
      const invalidFrames: Array<[string, string]> = [
        ['empty CPU usage objects', JSON.stringify(frame({
          cpu_stats: { cpu_usage: {}, system_cpu_usage: 2000, online_cpus: 1 },
          precpu_stats: { cpu_usage: {}, system_cpu_usage: 1000 },
        }))],
        ['a missing current CPU counter', JSON.stringify(frame({
          cpu_stats: { cpu_usage: {}, system_cpu_usage: 2000, online_cpus: 1 },
        }))],
        ['a nonnumeric CPU counter', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 'abc' }, system_cpu_usage: 2000, online_cpus: 1 },
        }))],
        ['a nonnumeric memory usage', JSON.stringify(frame({ memory_stats: { usage: 'lots' } }))],
        ['an object as memory usage', JSON.stringify(frame({ memory_stats: { usage: {} } }))],
        ['a nonnumeric system CPU counter', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 'x', online_cpus: 1 },
        }))],
        ['a nonnumeric previous system CPU counter', JSON.stringify(frame({
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 'x' },
        }))],
        // Finite inputs whose result overflows to Infinity.
        ['counters that overflow to an infinite CPU reading', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 1e308 }, system_cpu_usage: 1e-300, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        }))],
        ['a nonnumeric online CPU count', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 'two' },
        }))],
        ['a nonnumeric network byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 'x', tx_bytes: 1 } } }))],
        ['a nonnumeric transmit byte count beside a valid receive count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 1, tx_bytes: 'x' } } }))],
        // A malformed string in a byte count is rejected by the per-counter type
        // guard and, if that guard were removed, by the final finiteness check on the
        // sums. A boolean (0 + true is 1) passes the sum check, so only these two
        // fixtures fail when the numeric type guard on a byte count is removed.
        ['a boolean as the transmit byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 1, tx_bytes: true } } }))],
        ['a boolean as the receive byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: true, tx_bytes: 1 } } }))],
        ['a numeric string as the transmit byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 1, tx_bytes: '512' } } }))],
        ['a numeric string as the receive byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: '1024', tx_bytes: 1 } } }))],
        ['a bad counter on a second network interface', JSON.stringify(frame({
          networks: { eth0: { rx_bytes: 1, tx_bytes: 1 }, eth1: { rx_bytes: 1, tx_bytes: 'x' } },
        }))],
        // A valid current CPU total beside a previous total that is null, nonnumeric or a numeric string.
        ['a null previous CPU counter', JSON.stringify(frame({
          precpu_stats: { cpu_usage: { total_usage: null }, system_cpu_usage: 1000 },
        }))],
        ['a nonnumeric previous CPU counter', JSON.stringify(frame({
          precpu_stats: { cpu_usage: { total_usage: 'abc' }, system_cpu_usage: 1000 },
        }))],
        ['a numeric string as the previous CPU counter', JSON.stringify(frame({
          precpu_stats: { cpu_usage: { total_usage: '100' }, system_cpu_usage: 1000 },
        }))],
        ['a numeric string as the CPU counter', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: '200' }, system_cpu_usage: 2000, online_cpus: 1 },
        }))],
        ['a numeric string as memory usage', JSON.stringify(frame({ memory_stats: { usage: '1048576' } }))],
        ['a numeric string as the system CPU counter', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: '2000', online_cpus: 1 },
        }))],
        // 1e999 parses to Infinity; an infinite system delta would otherwise read as 0% CPU.
        ['an infinite system CPU counter', JSON.stringify(frame()).replace('2000', '1e999')],
        ['an infinite previous system CPU counter', JSON.stringify(frame()).replace('"system_cpu_usage":1000', '"system_cpu_usage":1e999')],
        // Each interface is finite; only the sum overflows.
        ['network receive totals that overflow across interfaces', JSON.stringify(frame({
          networks: { a: { rx_bytes: 1e308, tx_bytes: 1 }, b: { rx_bytes: 1e308, tx_bytes: 1 } },
        }))],
        ['network transmit totals that overflow across interfaces', JSON.stringify(frame({
          networks: { a: { rx_bytes: 1, tx_bytes: 1e308 }, b: { rx_bytes: 1, tx_bytes: 1e308 } },
        }))],
        ['a numeric string as the online CPU count', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: '2' },
        }))],
        // A frame with a whole stats section absent is dropped without being reported.
        ['no current CPU stats', JSON.stringify(frame({ cpu_stats: undefined }))],
        ['no previous CPU stats', JSON.stringify(frame({ precpu_stats: undefined }))],
        ['no CPU usage object', JSON.stringify(frame({
          cpu_stats: { system_cpu_usage: 2000, online_cpus: 1 },
        }))],
        ['no previous CPU usage object', JSON.stringify(frame({
          precpu_stats: { system_cpu_usage: 1000 },
        }))],
        ['no memory stats', JSON.stringify(frame({ memory_stats: undefined }))],
        ['no memory usage', JSON.stringify(frame({ memory_stats: {} }))],
        // A container that is not running reports zero memory.
        ['a memory usage of zero', JSON.stringify(frame({ memory_stats: { usage: 0 } }))],
        // 1e999 parses to Infinity.
        ['an infinite memory usage', JSON.stringify(frame()).replace('1048576', '1e999')],
        // Several defects in one frame are still dropped.
        ['empty CPU counters with nonnumeric memory', JSON.stringify(frame({
          cpu_stats: { cpu_usage: {}, system_cpu_usage: 2000 },
          precpu_stats: { cpu_usage: {}, system_cpu_usage: 1000 },
          memory_stats: { usage: 'lots' },
        }))],
      ];

      const nonnumericMemoryFrame = JSON.stringify(frame({ memory_stats: { usage: 'lots' } }));

      it.each(invalidFrames)('keeps a real warning and publishes nothing for %s, then recovers on a valid sample', (_name, bad) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        const ws = MockWS.instances[0];
        act(() => { ws.onerror?.(); });

        act(() => { ws.onmessage?.({ data: bad }); });
        act(() => { vi.advanceTimersByTime(1500); });
        expect(result.current.error).toMatch(/unavailable/);
        expect(result.current.stats['c1']).toBeUndefined();

        act(() => { ws.onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it.each(invalidFrames)('does not raise a warning or publish a metric on its own for %s', (_name, bad) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onmessage?.({ data: bad }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('keeps the warning when a replacement socket sends an unusable frame first', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });

        act(() => { MockWS.instances[1].onmessage?.({ data: nonnumericMemoryFrame }); });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it('still accepts a sample that sends null for the optional counters', () => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onerror?.(); });
        const nulls = JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: null, online_cpus: null },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: null },
          memory_stats: { usage: 1048576 },
          networks: { eth0: { rx_bytes: null, tx_bytes: null } },
        });
        act(() => { MockWS.instances[0].onmessage?.({ data: nulls }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toMatchObject({ cpu: '0.00%', ram: '1.00 MB' });
        warnSpy.mockRestore();
      });

      // Docker's first streaming frame carries an all-zero previous sample, and a
      // container that has used no CPU yet reports a zero total. Both are valid
      // readings: only the memory usage must be nonzero.
      const zeroCpuFrames: Array<[string, Record<string, unknown>]> = [
        ['a zero previous CPU total and zero previous system CPU time', {
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        }],
        ['a zero current CPU total beside a zero previous total', {
          cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 2000, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 1000 },
        }],
        ['a Docker first frame: zero previous sample and no network map', {
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
          networks: undefined,
        }],
      ];

      it.each(zeroCpuFrames)('clears a real warning and publishes the readings for %s', (_name, over) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[0].onmessage?.({ data: JSON.stringify(frame(over)) }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toMatchObject({ ram: '1.00 MB' });
        expect(result.current.stats['c1'].cpu).toMatch(/^\d+(\.\d+)?%$/);
        warnSpy.mockRestore();
      });

      it('still accepts a sample that leaves out the optional counters', () => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onerror?.(); });
        const minimal = JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: 200 } },
          precpu_stats: { cpu_usage: { total_usage: 100 } },
          memory_stats: { usage: 1048576 },
        });
        act(() => { MockWS.instances[0].onmessage?.({ data: minimal }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toMatchObject({ cpu: '0.00%', ram: '1.00 MB' });
        warnSpy.mockRestore();
      });
    });

    describe('container state changes', () => {
      it('records no failure for a stopped container, so a later start begins clean', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1', 'exited')]);
        act(() => { MockWS.instances[0].onerror?.(); });
        act(() => { MockWS.instances[0].onclose?.({ code: 1006 } as CloseEvent); });

        rerender({ containers: [makeContainer('c1', 'running')], nodeId: 1 });
        expect(result.current.error).toBeNull();

        // A fresh failure after the start still raises the warning.
        act(() => { MockWS.instances[1].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);
        warnSpy.mockRestore();
      });

      it('keeps the warning through a restart the list never shows as a stop, until the new stream delivers a sample', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1', 'running')]);
        act(() => { MockWS.instances[0].onclose?.({ code: 1006 } as CloseEvent); });
        expect(result.current.error).toMatch(/unavailable/);

        // Restart: same ID, running before and after, so the refresh reopens the socket.
        rerender({ containers: [makeContainer('c1', 'running')], nodeId: 1 });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it('does not carry a failure across running, stopped, running', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1', 'running')]);
        act(() => { MockWS.instances[0].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);

        rerender({ containers: [makeContainer('c1', 'exited')], nodeId: 1 });
        expect(result.current.error).toBeNull();

        rerender({ containers: [makeContainer('c1', 'running')], nodeId: 1 });
        expect(result.current.error).toBeNull();

        act(() => { MockWS.instances[2].onclose?.({ code: 1006 } as CloseEvent); });
        expect(result.current.error).toMatch(/unavailable/);
        warnSpy.mockRestore();
      });

      it('keeps a running container failure through a refresh that changes only a sibling state', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2', 'running')]);
        act(() => { MockWS.instances[0].onerror?.(); });

        rerender({ containers: [makeContainer('c1'), makeContainer('c2', 'exited')], nodeId: 1 });
        expect(result.current.error).toMatch(/unavailable/);
        warnSpy.mockRestore();
      });
    });

    it('still resets the warning on a node switch', () => {
      const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
      act(() => { MockWS.instances[0].onerror?.(); });

      rerender({ containers: [makeContainer('c1')], nodeId: 2 });

      expect(result.current.error).toBeNull();
      warnSpy.mockRestore();
    });
  });
});
