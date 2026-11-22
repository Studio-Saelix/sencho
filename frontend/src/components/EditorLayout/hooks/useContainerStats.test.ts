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

    // Same as setup, recording the error of every render so a test can assert
    // that the chip never showed, not only that it is gone at the end. The
    // effects that drop a stale flag run after the render, so errors[0] after a
    // rerender is the first render, before any effect has pruned the flag.
    const setupRecording = (initial: ContainerInfo[]) => {
      vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors: Array<string | null> = [];
      const hook = renderHook(
        ({ containers, nodeId }: Props) => {
          const r = useContainerStats(containers, nodeId);
          errors.push(r.error);
          return r;
        },
        { initialProps: { containers: initial, nodeId: 1 } as Props },
      );
      return { ...hook, errors, warnSpy };
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
        // The clamp of a backwards CPU total must not turn this overflow into 0%.
        ['counters that overflow to a negative infinite CPU reading', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: -1e308 }, system_cpu_usage: 1e-300, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 1e308 }, system_cpu_usage: 0 },
        }))],
        ['a nonnumeric online CPU count', JSON.stringify(frame({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 'two' },
        }))],
        ['a nonnumeric network byte count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 'x', tx_bytes: 1 } } }))],
        ['a nonnumeric transmit byte count beside a valid receive count', JSON.stringify(frame({ networks: { eth0: { rx_bytes: 1, tx_bytes: 'x' } } }))],
        // A malformed string in a byte count is rejected by the numeric check in
        // optionalCounter and, if that check were removed, by the final finiteness
        // check on the sums. A boolean (0 + true is 1) passes the sum check, so only
        // the two boolean fixtures below fail when optionalCounter's check goes.
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
      // Each row carries the CPU reading the frame must publish: a CPU delta that is
      // a tenth of the system delta is 10% on one CPU and 40% on four. Docker omits a
      // zero system time on the wire, so its first frame has no previous system time
      // at all: the system delta is then the whole current system time.
      const zeroCpuFrames: Array<[string, Record<string, unknown>, string]> = [
        ['a zero previous CPU total and zero previous system CPU time', {
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        }, '10.00%'],
        ['a zero current CPU total beside a zero previous total', {
          cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 2000, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 1000 },
        }, '0.00%'],
        ['a Docker first frame: no previous system CPU time, four online CPUs and no network map', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 0 } },
          networks: undefined,
        }, '40.00%'],
        ['a null previous system CPU time on four online CPUs', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: null },
        }, '40.00%'],
        ['a positive CPU delta on four online CPUs', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
        }, '40.00%'],
        // No usable system delta: the reading stays 0 instead of dividing by it.
        ['no current system CPU time beside a previous one', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, online_cpus: 4 },
        }, '0.00%'],
        // A CPU total that went backwards (a counter reset or a restart) is an
        // interval with no usage: it reads 0.00%, never a negative percentage, and
        // a drop too small to show still must not render as -0.00%.
        ['a CPU total that went backwards', {
          cpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 2000, online_cpus: 1 },
        }, '0.00%'],
        ['a CPU total that went backwards on four online CPUs', {
          cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 2000, online_cpus: 4 },
        }, '0.00%'],
        ['a CPU total that dropped by less than a hundredth of a percent', {
          cpu_stats: { cpu_usage: { total_usage: 99.99 }, system_cpu_usage: 2000000, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        }, '0.00%'],
        // The online CPU count is optional: absent, null or zero scales by one CPU.
        ['a positive CPU delta with no online CPU count', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000 },
        }, '10.00%'],
        ['a positive CPU delta with an online CPU count of zero', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 0 },
        }, '10.00%'],
        ['a positive CPU delta with a null online CPU count', {
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: null },
        }, '10.00%'],
      ];

      it.each(zeroCpuFrames)('clears a real warning and publishes the readings for %s', (_name, over, cpu) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[0].onmessage?.({ data: JSON.stringify(frame(over)) }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toMatchObject({ cpu, ram: '1.00 MB' });
        warnSpy.mockRestore();
      });

      it('keeps a reset CPU total out of the history as a nonnegative point', () => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => {
          MockWS.instances[0].onmessage?.({ data: JSON.stringify(frame({
            cpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 2000, online_cpus: 1 },
          })) });
        });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.stats['c1'].history.cpu).toEqual([0]);
        warnSpy.mockRestore();
      });

      // The network rate is the change in the byte counters between two frames, so
      // each row sends a baseline frame and then a frame that moves the counters by
      // the given amount. The unit must always be a real one.
      const netFrame = (rx: number, tx: number) => JSON.stringify(frame({
        networks: { eth0: { rx_bytes: rx, tx_bytes: tx } },
      }));
      const rateRows: Array<[string, number, number, string]> = [
        ['under a byte', 0.5, 0.25, '0.5 B/s ↓ / 0.25 B/s ↑'],
        ['a hundredth of a byte', 0.001, 0.01, '0 B/s ↓ / 0.01 B/s ↑'],
        ['just under a megabyte', 1024 * 1024 - 1, 1024 * 1024 - 1, '1024 KB/s ↓ / 1024 KB/s ↑'],
        ['a kilobyte', 2048, 1024, '2 KB/s ↓ / 1 KB/s ↑'],
        ['a terabyte', 2 * 1024 ** 4, 1024 ** 4, '2 TB/s ↓ / 1 TB/s ↑'],
        ['a petabyte', 3 * 1024 ** 5, 1024 ** 5, '3 PB/s ↓ / 1 PB/s ↑'],
        ['an exabyte', 1024 ** 6, 1024 ** 6, '1 EB/s ↓ / 1 EB/s ↑'],
        ['more than the largest unit', 2048 * 1024 ** 8, 1024 ** 8, '2048 YB/s ↓ / 1 YB/s ↑'],
      ];
      it.each(rateRows)('renders a network rate of %s with a unit', (_name, rxDelta, txDelta, net) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onmessage?.({ data: netFrame(0, 0) }); });
        act(() => { MockWS.instances[0].onmessage?.({ data: netFrame(rxDelta, txDelta) }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.stats['c1'].net).toBe(net);
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
      // Only the render-time guards (the running-state filter and the node tag)
      // keep the chip out of the first render after a list or node change.
      it.each(['created', 'restarting', 'removing', 'paused', 'exited', 'dead'])(
        'shows no chip on the first render after a failed running container is listed as %s',
        (state) => {
          const { result, rerender, errors, warnSpy } = setupRecording([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onerror?.(); });
          expect(result.current.error).toMatch(/unavailable/);

          errors.length = 0;
          rerender({ containers: [makeContainer('c1', state), makeContainer('c2')], nodeId: 1 });

          expect(errors[0]).toBeNull();
          expect(result.current.error).toBeNull();
          warnSpy.mockRestore();
        },
      );

      it('shows no chip on the first render after a failed container is removed from the list', () => {
        const { rerender, errors, warnSpy } = setupRecording([makeContainer('c1'), makeContainer('c2')]);
        act(() => { MockWS.instances[0].onerror?.(); });

        errors.length = 0;
        rerender({ containers: [makeContainer('c2')], nodeId: 1 });

        expect(errors[0]).toBeNull();
        warnSpy.mockRestore();
      });

      it('shows no chip on the first render after switching to a different stack', () => {
        const { rerender, errors, warnSpy } = setupRecording([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });

        errors.length = 0;
        rerender({ containers: [makeContainer('c2')], nodeId: 1 });

        expect(errors[0]).toBeNull();
        warnSpy.mockRestore();
      });

      it('shows no chip on the first render after the active node changes', () => {
        const { rerender, errors, warnSpy } = setupRecording([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });

        errors.length = 0;
        rerender({ containers: [makeContainer('c1')], nodeId: 2 });

        expect(errors[0]).toBeNull();
        warnSpy.mockRestore();
      });

      it('does not bring a node\'s failure back when the active node returns to it', () => {
        const { result, rerender, errors, warnSpy } = setupRecording([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);

        rerender({ containers: [makeContainer('c1')], nodeId: 2 });
        errors.length = 0;
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });

        expect(errors[0]).toBeNull();
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it('raises and clears a failure that happens after the active node changed', () => {
        const { result, rerender, warnSpy } = setupRecording([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });
        rerender({ containers: [makeContainer('c1')], nodeId: 2 });
        expect(result.current.error).toBeNull();

        act(() => { MockWS.instances[1].onerror?.(); });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it('keeps the chip on the first render after a refresh that lists the failed container as running', () => {
        const { rerender, errors, warnSpy } = setupRecording([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onerror?.(); });

        errors.length = 0;
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });

        expect(errors[0]).toMatch(/unavailable/);
        warnSpy.mockRestore();
      });

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

    // The backend reports the Docker stream's own failure or end as a frame and
    // keeps the socket open, so these frames are the only signal that the
    // stream has stopped delivering.
    describe('stream failure and end frames on an open socket', () => {
      const errorFrames: Array<[string, string]> = [
        ['an error frame', JSON.stringify({ error: 'read: connection reset by peer' })],
        ['an error frame with an empty message', JSON.stringify({ error: '' })],
      ];
      const endFrame = JSON.stringify({ end: true });
      const stopFrames: Array<[string, string]> = [...errorFrames, ['an end frame', endFrame]];

      it.each(errorFrames)('raises the warning on %s and keeps the last reading on screen', (_name, stop) => {
        const { result, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        const ws = MockWS.instances[0];
        act(() => { ws.onmessage?.({ data: validSample }); });
        act(() => { vi.advanceTimersByTime(1500); });
        const reading = result.current.stats['c1'];
        expect(reading.cpu).toBe('10.00%');
        expect(result.current.error).toBeNull();

        act(() => { ws.onmessage?.({ data: stop }); });
        act(() => { vi.advanceTimersByTime(1500); });

        expect(result.current.error).toMatch(/unavailable/);
        expect(result.current.stats['c1']).toBe(reading);
        expect(warnSpy).toHaveBeenCalledWith(
          '[useContainerStats] stats stream failure:',
          expect.objectContaining({ kind: 'stream-error', containerId: 'c1' }),
        );
        warnSpy.mockRestore();
      });

      it('logs the message an error frame carries', () => {
        const { warnSpy } = setup([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: JSON.stringify({ error: 'read: connection reset by peer' }) }); });

        expect(warnSpy).toHaveBeenCalledWith(
          '[useContainerStats] stats stream failure:',
          { kind: 'stream-error', containerId: 'c1', detail: 'read: connection reset by peer' },
        );
        warnSpy.mockRestore();
      });

      it.each(errorFrames)('clears the warning raised by %s on the next valid sample from the same socket', (_name, stop) => {
        const { result, warnSpy } = setup([makeContainer('c1')]);
        const ws = MockWS.instances[0];
        act(() => { ws.onmessage?.({ data: stop }); });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { ws.onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it.each(errorFrames)('clears the warning raised by %s when the replacement socket delivers a sample', (_name, stop) => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: stop }); });

        rerender({ containers: [makeContainer('c1')], nodeId: 1 });
        expect(result.current.error).toMatch(/unavailable/);

        act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });
        expect(result.current.error).toBeNull();
        warnSpy.mockRestore();
      });

      it('keeps the warning while the failed container has not recovered and a sibling streams', () => {
        const { result, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: errorFrames[0][1] }); });
        act(() => { MockWS.instances[1].onmessage?.({ data: validSample }); });

        expect(result.current.error).toMatch(/unavailable/);
        warnSpy.mockRestore();
      });

      it.each(stopFrames)('ignores %s for a container the list shows as not running', (_name, stop) => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1', 'exited')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: stop }); });
        rerender({ containers: [makeContainer('c1', 'exited')], nodeId: 1 });

        expect(result.current.error).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it.each(stopFrames)('ignores %s from a torn-down socket', (_name, stop) => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
        const { onmessage } = MockWS.instances[0];
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });

        act(() => { onmessage?.({ data: stop }); });
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });
        expect(result.current.error).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it.each([[false], [1], ['true']])('does not read an end flag of %j as the end of the stream', (end) => {
        const { result, rerender, warnSpy } = setup([makeContainer('c1')], { fakeTimers: true });
        act(() => { MockWS.instances[0].onmessage?.({ data: JSON.stringify({ end }) }); });
        act(() => { vi.advanceTimersByTime(1500); });
        rerender({ containers: [makeContainer('c1')], nodeId: 1 });

        expect(result.current.error).toBeNull();
        expect(result.current.stats['c1']).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      // Docker ends a container's stats stream when the container is removed, so
      // every Take down, every Save & Deploy, update or rollback that recreates a
      // running container, and every host-side removal sends an end frame for a
      // healthy node. The chip is for a stream that died while its container
      // lives, which only the next container list can tell.
      describe('an end frame', () => {
        it('shows no chip while the list has not caught up with the removal', () => {
          const { result, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('never shows the chip when the next list no longer has the container (Take down)', () => {
          const { result, rerender, errors, warnSpy } = setupRecording([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          act(() => { MockWS.instances[1].onmessage?.({ data: endFrame }); });

          rerender({ containers: [], nodeId: 1 });

          expect(errors.every(e => e === null)).toBe(true);
          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('never shows the chip when the next list holds a recreated container under a new ID (Save & Deploy)', () => {
          const { result, rerender, errors, warnSpy } = setupRecording([makeContainer('old-web'), makeContainer('db')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('new-web'), makeContainer('db')], nodeId: 1 });
          act(() => { MockWS.instances[2].onmessage?.({ data: validSample }); });

          expect(errors.every(e => e === null)).toBe(true);
          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it.each(['exited', 'created', 'removing', 'dead'])('never shows the chip when the next list shows the container as %s', (state) => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('c1', state)], nodeId: 1 });
          expect(result.current.error).toBeNull();

          // Starting it again begins clean: the old end does not come back.
          rerender({ containers: [makeContainer('c1')], nodeId: 1 });
          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('raises the chip when the next list still shows the container running, and says so in the console', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          expect(result.current.error).toBeNull();

          rerender({ containers: [makeContainer('c1'), makeContainer('c2')], nodeId: 1 });

          expect(result.current.error).toMatch(/unavailable/);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            '[useContainerStats] stats stream failure:',
            { kind: 'stream-end', containerId: 'c1' },
          );
          warnSpy.mockRestore();
        });

        it('keeps a raised chip across later refreshes until the replacement socket delivers a sample', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          rerender({ containers: [makeContainer('c1')], nodeId: 1 });
          rerender({ containers: [makeContainer('c1')], nodeId: 1 });
          expect(result.current.error).toMatch(/unavailable/);

          act(() => { MockWS.instances[MockWS.instances.length - 1].onmessage?.({ data: validSample }); });
          expect(result.current.error).toBeNull();
          warnSpy.mockRestore();
        });

        it('drops the pending end when the same socket delivers a valid sample afterwards', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          const ws = MockWS.instances[0];
          act(() => { ws.onmessage?.({ data: endFrame }); });
          act(() => { ws.onmessage?.({ data: validSample }); });

          rerender({ containers: [makeContainer('c1')], nodeId: 1 });
          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('settles an end against the first list only, not later ones', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          rerender({ containers: [], nodeId: 1 });
          rerender({ containers: [makeContainer('c1')], nodeId: 1 });

          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('does not carry a pending end over to another node', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('c1')], nodeId: 2 });

          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('ignores an end frame from a container that was not running, even when the next list runs it', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1', 'exited')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('c1')], nodeId: 1 });

          expect(result.current.error).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
          warnSpy.mockRestore();
        });

        it('keeps a pending end through a frame that is not a valid sample', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1')]);
          const ws = MockWS.instances[0];
          act(() => { ws.onmessage?.({ data: endFrame }); });
          act(() => { ws.onmessage?.({ data: noMemorySample }); });

          rerender({ containers: [makeContainer('c1')], nodeId: 1 });

          expect(result.current.error).toMatch(/unavailable/);
          warnSpy.mockRestore();
        });

        it('logs one warning for a container whose end frame arrives twice', () => {
          const { rerender, warnSpy } = setup([makeContainer('c1')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('c1')], nodeId: 1 });

          expect(warnSpy).toHaveBeenCalledTimes(1);
          warnSpy.mockRestore();
        });

        it('raises the chip only for the ended container the list still runs', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          act(() => { MockWS.instances[1].onmessage?.({ data: endFrame }); });

          rerender({ containers: [makeContainer('c2')], nodeId: 1 });

          expect(result.current.error).toMatch(/unavailable/);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            '[useContainerStats] stats stream failure:',
            { kind: 'stream-end', containerId: 'c2' },
          );
          warnSpy.mockRestore();
        });

        // A list fetched before the removal can land after the end frame. The
        // chip then shows until the next list, which no longer has the container.
        it('clears a chip a stale list raised once the next list drops the container', () => {
          const { result, rerender, warnSpy } = setup([makeContainer('c1'), makeContainer('c2')]);
          act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
          rerender({ containers: [makeContainer('c1'), makeContainer('c2')], nodeId: 1 });
          expect(result.current.error).toMatch(/unavailable/);

          rerender({ containers: [makeContainer('c2')], nodeId: 1 });

          expect(result.current.error).toBeNull();
          warnSpy.mockRestore();
        });
      });
    });

    // The warning has to say which containers lost their stats and whether the
    // node itself is the suspect: a frame the node sent on an open socket proves
    // it is reachable, a socket that failed or closed does not.
    describe('which containers failed and why', () => {
      const errorFrame = JSON.stringify({ error: 'stats read failed' });
      const endFrame = JSON.stringify({ end: true });

      it('names the container whose stream sent an error frame and blames the stream, not the node', () => {
        const { result, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: errorFrame }); });

        expect([...result.current.failures]).toEqual([['alpha', 'stream']]);
        expect(result.current.error).toMatch(/unavailable/);
        expect(result.current.error).toMatch(/reachable but reported/);
        expect(result.current.error).not.toMatch(/may be unreachable/);
        warnSpy.mockRestore();
      });

      it('names a container whose ended stream the next list still runs and blames the stream, not the node', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: endFrame }); });
        expect(result.current.failures.size).toBe(0);

        rerender({ containers: [makeContainer('alpha'), makeContainer('beta')], nodeId: 1 });

        expect([...result.current.failures]).toEqual([['alpha', 'stream']]);
        expect(result.current.error).toMatch(/reachable but reported/);
        expect(result.current.error).not.toMatch(/may be unreachable/);
        warnSpy.mockRestore();
      });

      it.each([
        ['a socket error', (ws: MockWS) => ws.onerror?.()],
        ['an abnormal close', (ws: MockWS) => ws.onclose?.({ code: 1006 } as CloseEvent)],
        ['a frame that cannot be parsed', (ws: MockWS) => ws.onmessage?.({ data: 'not json' })],
      ])('names the container and blames the node after %s', (_name, fail) => {
        const { result, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { fail(MockWS.instances[1]); });

        expect([...result.current.failures]).toEqual([['beta', 'transport']]);
        expect(result.current.error).toMatch(/node may be unreachable/);
        warnSpy.mockRestore();
      });

      it('words the warning for both causes when containers fail in both ways', () => {
        const { result, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: errorFrame }); });
        act(() => { MockWS.instances[1].onerror?.(); });

        expect(new Map(result.current.failures)).toEqual(new Map([['alpha', 'stream'], ['beta', 'transport']]));
        expect(result.current.error).toMatch(/may be unreachable, or it reported/);
        warnSpy.mockRestore();
      });

      it('lets a transport failure replace a stream cause on the same container, never the other way round', () => {
        const { result, warnSpy } = setup([makeContainer('alpha')]);
        const ws = MockWS.instances[0];
        act(() => { ws.onmessage?.({ data: errorFrame }); });
        act(() => { ws.onclose?.({ code: 1006 } as CloseEvent); });
        expect(result.current.failures.get('alpha')).toBe('transport');

        act(() => { ws.onmessage?.({ data: errorFrame }); });
        expect(result.current.failures.get('alpha')).toBe('transport');
        warnSpy.mockRestore();
      });

      it('keeps a transport cause when an end frame is settled against a list that still runs the container', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('alpha')]);
        const ws = MockWS.instances[0];
        act(() => { ws.onerror?.(); });
        act(() => { ws.onmessage?.({ data: endFrame }); });

        rerender({ containers: [makeContainer('alpha')], nodeId: 1 });

        expect(result.current.failures.get('alpha')).toBe('transport');
        expect(result.current.error).toMatch(/node may be unreachable/);
        warnSpy.mockRestore();
      });

      it('drops a container from the failures when it delivers a valid sample, and keeps the other', () => {
        const { result, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: errorFrame }); });
        act(() => { MockWS.instances[1].onmessage?.({ data: errorFrame }); });
        expect([...result.current.failures.keys()]).toEqual(['alpha', 'beta']);

        act(() => { MockWS.instances[0].onmessage?.({ data: validSample }); });

        expect([...result.current.failures.keys()]).toEqual(['beta']);
        warnSpy.mockRestore();
      });

      it('lists no failure for a container the list shows stopped, or after a node switch', () => {
        const { result, rerender, warnSpy } = setup([makeContainer('alpha'), makeContainer('beta')]);
        act(() => { MockWS.instances[0].onmessage?.({ data: errorFrame }); });
        act(() => { MockWS.instances[1].onmessage?.({ data: errorFrame }); });

        rerender({ containers: [makeContainer('alpha', 'exited'), makeContainer('beta')], nodeId: 1 });
        expect([...result.current.failures.keys()]).toEqual(['beta']);

        rerender({ containers: [makeContainer('alpha', 'exited'), makeContainer('beta')], nodeId: 2 });
        expect(result.current.failures.size).toBe(0);
        expect(result.current.error).toBeNull();
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
