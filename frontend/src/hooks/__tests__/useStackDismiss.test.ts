import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { preflightFingerprint, scanBannerFingerprint, useStackDismiss } from '../useStackDismiss';

const findings = (sev: string) => [
  { ruleId: 'DS001', severity: sev, service: 'web' },
  { ruleId: 'DS002', severity: 'warning' },
];

const doctor = (stack: string, node: number | undefined, fp: string) =>
  renderHook(() => useStackDismiss('doctor', stack, node, fp));

describe('useStackDismiss (doctor channel)', () => {
  beforeEach(() => localStorage.clear());

  it('is not dismissed until dismiss() is called', () => {
    const { result } = doctor('app', 1, preflightFingerprint(findings('high')));
    expect(result.current.dismissed).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
  });

  it('stays dismissed for an identical finding set (order-independent)', () => {
    const first = doctor('app', 1, preflightFingerprint(findings('high')));
    act(() => first.result.current.dismiss());
    const reordered = [...findings('high')].reverse();
    const second = doctor('app', 1, preflightFingerprint(reordered));
    expect(second.result.current.dismissed).toBe(true);
  });

  it('re-surfaces when the findings change', () => {
    const first = doctor('app', 1, preflightFingerprint(findings('high')));
    act(() => first.result.current.dismiss());
    const changed = doctor('app', 1, preflightFingerprint(findings('blocker')));
    expect(changed.result.current.dismissed).toBe(false);
  });

  it('keys per stack and node', () => {
    const fp = preflightFingerprint(findings('high'));
    const a = doctor('app', 1, fp);
    act(() => a.result.current.dismiss());
    expect(doctor('other', 1, fp).result.current.dismissed).toBe(false);
    expect(doctor('app', 2, fp).result.current.dismissed).toBe(false);
  });

  it('treats an empty finding set as never dismissed', () => {
    const { result } = doctor('app', 1, preflightFingerprint([]));
    expect(result.current.dismissed).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(false);
  });
});

describe('useStackDismiss storage contract', () => {
  beforeEach(() => localStorage.clear());

  it('reads dismissals written under the existing keys', () => {
    localStorage.setItem('sencho.doctorDismissed.app.1', 'fp');
    localStorage.setItem('sencho.scanBannerDismissed.app.local', 'failed:5');
    expect(renderHook(() => useStackDismiss('doctor', 'app', 1, 'fp')).result.current.dismissed).toBe(true);
    expect(renderHook(() => useStackDismiss('scanBanner', 'app', undefined, 'failed:5')).result.current.dismissed).toBe(true);
  });

  it('keeps a banner and its tab dot in step without a reload', () => {
    const banner = doctor('app', 1, 'fp');
    const dot = doctor('app', 1, 'fp');
    act(() => banner.result.current.dismiss());
    expect(dot.result.current.dismissed).toBe(true);
  });

  it('leaves the banner showing when storage cannot be written', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = doctor('app', 1, 'fp');
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(false);
    spy.mockRestore();
  });
});

describe('useStackDismiss (scan banner channel)', () => {
  beforeEach(() => localStorage.clear());

  const banner = (status: string | null, attemptedAt?: number) =>
    renderHook(() => useStackDismiss('scanBanner', 'app', 1, scanBannerFingerprint(status, attemptedAt)));

  it('stays dismissed for the same scan result', () => {
    const first = banner('failed', 100);
    act(() => first.result.current.dismiss());
    expect(banner('failed', 100).result.current.dismissed).toBe(true);
  });

  it('re-surfaces when a new scan attempt lands, even with the same status', () => {
    const first = banner('failed', 100);
    act(() => first.result.current.dismiss());
    expect(banner('failed', 200).result.current.dismissed).toBe(false);
  });

  it('re-surfaces when the status changes', () => {
    const first = banner('failed', 100);
    act(() => first.result.current.dismiss());
    expect(banner('partial', 100).result.current.dismissed).toBe(false);
  });

  it('never dismisses an empty status', () => {
    const { result } = banner(null);
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(false);
  });

  it('keeps the doctor and banner dismissals apart', () => {
    const fp = 'x';
    const d = renderHook(() => useStackDismiss('doctor', 'app', 1, fp));
    act(() => d.result.current.dismiss());
    const b = renderHook(() => useStackDismiss('scanBanner', 'app', 1, fp));
    expect(b.result.current.dismissed).toBe(false);
  });
});
