import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockBuildInfo = vi.fn();
vi.mock('@/hooks/useBuildInfo', () => ({
  useBuildInfo: () => mockBuildInfo(),
}));

import { useWhatsNewPreference } from '../useWhatsNewPreference';

const LAST_SEEN = 'sencho.whatsNew.lastSeenVersion';

function givenBuild(version: string | null, channel: 'stable' | 'dev' = 'stable') {
  mockBuildInfo.mockReturnValue({
    buildInfo: version === null ? null : { version, channel, imageChannel: 'community', imageRef: null, imageId: null, revision: null, restricted: false },
    status: 'ready',
    retry: vi.fn(),
  });
}

describe('useWhatsNewPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    givenBuild('0.98.1');
  });
  afterEach(() => localStorage.clear());

  it('defaults enabled to true when never set', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.enabled).toBe(true);
  });

  it('respects a stored disabled preference', () => {
    localStorage.setItem('sencho.whatsNew.enabled', '0');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.enabled).toBe(false);
  });

  it('setEnabled persists and updates state', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem('sencho.whatsNew.enabled')).toBe('0');
  });

  it('exposes the running stable version', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.version).toBe('0.98.1');
  });

  it('a fresh install (no stored version) silently catches up, so hasUnseen stays false', () => {
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(localStorage.getItem(LAST_SEEN)).toBe('0.98.1');
    expect(result.current.hasUnseen).toBe(false);
  });

  it('a stored version behind the running one reports hasUnseen true', () => {
    localStorage.setItem(LAST_SEEN, '0.98.0');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(true);
  });

  it('running an older release than the one last seen does not light the dot', () => {
    localStorage.setItem(LAST_SEEN, '0.99.0');
    const { result } = renderHook(() => useWhatsNewPreference());
    expect(result.current.hasUnseen).toBe(false);
  });

  it('removes the retired hand-written feed watermark when it stamps the new one', () => {
    localStorage.setItem('sencho.whatsNew.lastSeenId', 'v0-98-0-old-entry');
    renderHook(() => useWhatsNewPreference());
    expect(localStorage.getItem('sencho.whatsNew.lastSeenId')).toBeNull();
    expect(localStorage.getItem(LAST_SEEN)).toBe('0.98.1');
  });

  it('markSeen clears hasUnseen and stores the running version', () => {
    localStorage.setItem(LAST_SEEN, '0.98.0');
    const { result } = renderHook(() => useWhatsNewPreference());
    act(() => result.current.markSeen());
    expect(result.current.hasUnseen).toBe(false);
    expect(localStorage.getItem(LAST_SEEN)).toBe('0.98.1');
  });

  it('never stamps or flags anything for a dev build or while build info is loading', () => {
    givenBuild('0.98.1', 'dev');
    const dev = renderHook(() => useWhatsNewPreference());
    expect(dev.result.current.version).toBeNull();
    expect(dev.result.current.hasUnseen).toBe(false);
    act(() => dev.result.current.markSeen());
    givenBuild(null);
    const loading = renderHook(() => useWhatsNewPreference());
    expect(loading.result.current.version).toBeNull();
    expect(localStorage.getItem(LAST_SEEN)).toBeNull();
  });

  it('a second hook instance picks up a change made by the first (window event sync)', () => {
    const a = renderHook(() => useWhatsNewPreference());
    const b = renderHook(() => useWhatsNewPreference());
    act(() => a.result.current.setEnabled(false));
    expect(b.result.current.enabled).toBe(false);
  });
});
