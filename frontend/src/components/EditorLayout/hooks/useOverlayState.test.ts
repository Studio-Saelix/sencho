import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useOverlayState } from './useOverlayState';

describe('useOverlayState', () => {
  it('initialises with all overlays closed and null/empty data', () => {
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.createDialogOpen).toBe(false);
    expect(result.current.deleteDialogOpen).toBe(false);
    expect(result.current.stackToDelete).toBeNull();
    expect(result.current.pendingUnsavedLoad).toBeNull();
    expect(result.current.pendingUnsavedNode).toBeNull();
    expect(result.current.bashModalOpen).toBe(false);
    expect(result.current.selectedContainer).toBeNull();
    expect(result.current.logViewerOpen).toBe(false);
    expect(result.current.logContainer).toBeNull();
    expect(result.current.stackMonitor).toBeNull();
    expect(result.current.policyBlock).toBeNull();
    expect(result.current.policyBypassing).toBe(false);
    expect(result.current.stackMisconfigScanId).toBeNull();
    expect(result.current.diffPreview).toBeNull();
    expect(result.current.diffPreviewConfirming).toBe(false);
  });

  it('openBashModal sets open flag and container object', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openBashModal({ id: 'abc', name: 'my-container' }));
    expect(result.current.bashModalOpen).toBe(true);
    expect(result.current.selectedContainer).toEqual({ id: 'abc', name: 'my-container' });
  });

  it('closeBashModal resets bash state', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openBashModal({ id: 'abc', name: 'my-container' }));
    act(() => result.current.closeBashModal());
    expect(result.current.bashModalOpen).toBe(false);
    expect(result.current.selectedContainer).toBeNull();
  });

  it('openDeleteDialog sets open flag and stack name', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openDeleteDialog('my-stack'));
    expect(result.current.deleteDialogOpen).toBe(true);
    expect(result.current.stackToDelete).toBe('my-stack');
  });

  it('closeDeleteDialog resets delete state', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openDeleteDialog('my-stack'));
    act(() => result.current.closeDeleteDialog());
    expect(result.current.deleteDialogOpen).toBe(false);
    expect(result.current.stackToDelete).toBeNull();
  });

  it('openLogViewer sets open flag and container object', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openLogViewer({ id: 'xyz', name: 'log-container' }));
    expect(result.current.logViewerOpen).toBe(true);
    expect(result.current.logContainer).toEqual({ id: 'xyz', name: 'log-container' });
  });

  it('closeLogViewer resets log viewer state', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openLogViewer({ id: 'xyz', name: 'log-container' }));
    act(() => result.current.closeLogViewer());
    expect(result.current.logViewerOpen).toBe(false);
    expect(result.current.logContainer).toBeNull();
  });

  it('openAlertSheet opens stack monitor on the alerts tab', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openAlertSheet('web-stack'));
    expect(result.current.stackMonitor).toEqual({ stackName: 'web-stack', tab: 'alerts' });
  });

  it('openAutoHeal opens stack monitor on the auto-heal tab', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openAutoHeal('web-stack'));
    expect(result.current.stackMonitor).toEqual({ stackName: 'web-stack', tab: 'auto-heal' });
  });

  it('openAutoHeal after openAlertSheet switches to the auto-heal tab', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openAlertSheet('web-stack'));
    act(() => result.current.openAutoHeal('web-stack'));
    expect(result.current.stackMonitor).toEqual({ stackName: 'web-stack', tab: 'auto-heal' });
  });

  it('closeStackMonitor clears the stack monitor state', () => {
    const { result } = renderHook(() => useOverlayState());
    act(() => result.current.openAlertSheet('web-stack'));
    act(() => result.current.closeStackMonitor());
    expect(result.current.stackMonitor).toBeNull();
  });
});
