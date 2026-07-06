import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditorViewState, LOGS_MODE_STORAGE_KEY } from '../hooks/useEditorViewState';

describe('useEditorViewState', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('defaults all string fields to empty string', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.content).toBe('');
      expect(result.current.originalContent).toBe('');
      expect(result.current.envContent).toBe('');
      expect(result.current.originalEnvContent).toBe('');
      expect(result.current.selectedEnvFile).toBe('');
    });

    it('defaults all boolean fields to false', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.stackMisconfigScanning).toBe(false);
      expect(result.current.envExists).toBe(false);
      expect(result.current.gitSourceOpen).toBe(false);
      expect(result.current.isFileLoading).toBe(false);
      expect(result.current.isEditing).toBe(false);
      expect(result.current.editingCompose).toBe(false);
    });

    it('defaults all collection fields to empty', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.envFiles).toEqual([]);
      expect(result.current.containers).toEqual([]);
      expect(result.current.gitSourcePendingMap).toEqual({});
    });

    it('defaults activeTab to compose', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.activeTab).toBe('compose');
    });

    it('defaults backupInfo to absent', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.backupInfo).toEqual({ exists: false, timestamp: null });
    });
  });

  describe('setters', () => {
    it('setContent updates content', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setContent('services:\n  web:\n    image: nginx'));
      expect(result.current.content).toBe('services:\n  web:\n    image: nginx');
    });

    it('setActiveTab updates activeTab', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setActiveTab('env'));
      expect(result.current.activeTab).toBe('env');
    });

    it('setIsEditing toggles edit mode', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setIsEditing(true));
      expect(result.current.isEditing).toBe(true);
    });

    it('setBackupInfo replaces the whole object', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setBackupInfo({ exists: true, timestamp: 1234567890 }));
      expect(result.current.backupInfo).toEqual({ exists: true, timestamp: 1234567890 });
    });

    it('setContainers accepts a new container array', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setContainers([{ Id: 'abc', Names: ['/web'], State: 'running' }]));
      expect(result.current.containers).toHaveLength(1);
      expect(result.current.containers[0].Id).toBe('abc');
    });
  });

  describe('logsMode persistence', () => {
    it('hydrates from localStorage on mount', () => {
      window.localStorage.setItem(LOGS_MODE_STORAGE_KEY, 'raw');
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.logsMode).toBe('raw');
    });

    it('defaults to structured when storage is empty', () => {
      const { result } = renderHook(() => useEditorViewState());
      expect(result.current.logsMode).toBe('structured');
    });

    it('persists to localStorage on change', () => {
      const { result } = renderHook(() => useEditorViewState());
      act(() => result.current.setLogsMode('raw'));
      expect(window.localStorage.getItem(LOGS_MODE_STORAGE_KEY)).toBe('raw');
    });
  });
});
