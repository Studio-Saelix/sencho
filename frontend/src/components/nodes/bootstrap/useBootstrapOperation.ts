import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import {
  cancelBootstrapOperation,
  fetchBootstrapOperation,
  listBootstrapOperations,
  releaseBootstrapOperation,
} from './bootstrapApi';
import { isOperationRunning } from './operationStatus';
import type { BootstrapOperation, BootstrapOperationDetail } from './types';

/**
 * The bootstrap operation the dialog shows, and the recent ones it lists.
 *
 * The run lives on the hub, so this hook only reads it. While the shown
 * operation is running and the dialog is open, it is fetched again every two
 * seconds; a hidden tab skips the fetch and an operation that stopped ends
 * the polling. Nothing polls while the dialog is closed.
 */

export const OPERATION_POLL_MS = 2_000;

export interface UseBootstrapOperationOptions {
  open: boolean;
  api?: {
    get: typeof fetchBootstrapOperation;
    list: typeof listBootstrapOperations;
    cancel: typeof cancelBootstrapOperation;
    release: typeof releaseBootstrapOperation;
  };
}

type OperationBusy = 'open' | 'cancel' | 'release' | null;

export function useBootstrapOperation({ open, api }: UseBootstrapOperationOptions) {
  const client = api ?? {
    get: fetchBootstrapOperation,
    list: listBootstrapOperations,
    cancel: cancelBootstrapOperation,
    release: releaseBootstrapOperation,
  };
  const [operation, setOperation] = useState<BootstrapOperationDetail | null>(null);
  const [operations, setOperations] = useState<BootstrapOperation[]>([]);
  const [busy, setBusy] = useState<OperationBusy>(null);
  // The shown operation's id, so a reply for one the operator has moved away
  // from is dropped instead of replacing the current view.
  const shownRef = useRef<string | null>(null);

  const show = useCallback((detail: BootstrapOperationDetail | null) => {
    shownRef.current = detail?.id ?? null;
    setOperation(detail);
  }, []);

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    try {
      setOperations(await client.list(signal));
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // The list is a convenience; the wizard stays usable without it.
      console.warn('Bootstrap operations could not be listed:', error);
    }
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dialog clears the shown operation when it closes (`show(null)`); the
  // list is fetched again on every open so a run started elsewhere appears.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    client.list(controller.signal)
      .then(setOperations)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Bootstrap operations could not be listed:', error);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openOperation = useCallback(async (id: string): Promise<BootstrapOperationDetail | null> => {
    setBusy('open');
    try {
      const detail = await client.get(id);
      show(detail);
      return detail;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'The bootstrap could not be loaded.');
      return null;
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const running = operation !== null && isOperationRunning(operation);
  const operationId = operation?.id ?? null;
  // Bumped after every poll, answered or not, so a long step that changes
  // nothing on the hub still gets the next tick.
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!open || !running || !operationId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      // A hidden tab does not poll; the next visible tick picks the run up.
      if (document.hidden) {
        setPollTick((tick) => tick + 1);
        return;
      }
      void client.get(operationId, controller.signal)
        .then((detail) => {
          if (shownRef.current === detail.id) setOperation(detail);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          // A failed poll keeps the last state on screen; the next tick tries again.
          console.warn('Bootstrap progress could not be refreshed:', error);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPollTick((tick) => tick + 1);
        });
    }, OPERATION_POLL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running, operationId, pollTick]);

  const act = useCallback(async (kind: 'cancel' | 'release') => {
    if (!operationId) return;
    setBusy(kind);
    try {
      const detail = kind === 'cancel' ? await client.cancel(operationId) : await client.release(operationId);
      if (shownRef.current === detail.id) setOperation(detail);
      if (kind === 'release') toast.success('Server released. Nothing on it was changed.');
      void refreshList();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : `The bootstrap could not be ${kind === 'cancel' ? 'cancelled' : 'released'}.`);
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId, refreshList]);

  return {
    operation,
    operations,
    busy,
    show,
    openOperation,
    refreshList,
    cancel: () => act('cancel'),
    release: () => act('release'),
  };
}

export type UseBootstrapOperation = ReturnType<typeof useBootstrapOperation>;
