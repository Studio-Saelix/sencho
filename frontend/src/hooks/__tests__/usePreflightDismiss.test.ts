import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreflightDismiss } from '../usePreflightDismiss';

const findings = (sev: string) => [
  { ruleId: 'DS001', severity: sev, service: 'web' },
  { ruleId: 'DS002', severity: 'warning' },
];

describe('usePreflightDismiss', () => {
  beforeEach(() => localStorage.clear());

  it('is not dismissed until dismiss() is called', () => {
    const { result } = renderHook(() => usePreflightDismiss('app', 1, findings('high')));
    expect(result.current.dismissed).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
  });

  it('stays dismissed for an identical finding set (order-independent)', () => {
    const first = renderHook(() => usePreflightDismiss('app', 1, findings('high')));
    act(() => first.result.current.dismiss());
    // A fresh consumer with the same findings in a different order reads dismissed.
    const reordered = [...findings('high')].reverse();
    const second = renderHook(() => usePreflightDismiss('app', 1, reordered));
    expect(second.result.current.dismissed).toBe(true);
  });

  it('re-surfaces when the findings change', () => {
    const first = renderHook(() => usePreflightDismiss('app', 1, findings('high')));
    act(() => first.result.current.dismiss());
    // Severity changed -> different fingerprint -> not dismissed.
    const changed = renderHook(() => usePreflightDismiss('app', 1, findings('blocker')));
    expect(changed.result.current.dismissed).toBe(false);
  });

  it('keys per stack and node', () => {
    const a = renderHook(() => usePreflightDismiss('app', 1, findings('high')));
    act(() => a.result.current.dismiss());
    expect(renderHook(() => usePreflightDismiss('other', 1, findings('high'))).result.current.dismissed).toBe(false);
    expect(renderHook(() => usePreflightDismiss('app', 2, findings('high'))).result.current.dismissed).toBe(false);
  });

  it('treats an empty finding set as never dismissed', () => {
    const { result } = renderHook(() => usePreflightDismiss('app', 1, []));
    expect(result.current.dismissed).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(false);
  });
});
