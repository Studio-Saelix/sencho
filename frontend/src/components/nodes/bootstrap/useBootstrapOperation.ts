import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import {
  BootstrapApiError,
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
  const [listFailed, setListFailed] = useState(false);
  // Where the next page of held runs begins; null when the loaded rows end the holds.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped when a read of the first page starts and again when its answer is applied, so a later page that
  // was asked for with the old cursor, before or while that read ran, is dropped instead of stitched onto the new list.
  const listGeneration = useRef(0);
  // Consecutive failed progress reads for the shown run; reset by any answer.
  const [pollFailures, setPollFailures] = useState(0);
  const [busy, setBusy] = useState<OperationBusy>(null);
  // The shown operation's id, so a reply for one the operator has moved away
  // from is dropped instead of replacing the current view.
  const shownRef = useRef<string | null>(null);

  const show = useCallback((detail: BootstrapOperationDetail | null) => {
    shownRef.current = detail?.id ?? null;
    setOperation(detail);
    setPollFailures(0);
  }, []);

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    listGeneration.current += 1;
    try {
      const page = await client.list(signal);
      listGeneration.current += 1;
      setOperations(page.operations);
      setNextCursor(page.nextCursor);
      setListFailed(false);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // The wizard stays usable without the list; the dialog says it is missing.
      console.warn('Bootstrap operations could not be listed:', error);
      setListFailed(true);
    }
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dialog clears the shown operation when it closes (`show(null)`); the
  // list is fetched again on every open so a run started elsewhere appears.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listGeneration.current += 1;
    client.list(controller.signal)
      .then((page) => {
        listGeneration.current += 1;
        setOperations(page.operations);
        setNextCursor(page.nextCursor);
        setListFailed(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Bootstrap operations could not be listed:', error);
        setListFailed(true);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Read the next page of held runs and add it below the ones shown. */
  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    const generation = listGeneration.current;
    setLoadingMore(true);
    try {
      const page = await client.list(undefined, nextCursor);
      if (generation !== listGeneration.current) return;
      setOperations((shown) => {
        const known = new Set(shown.map((operation) => operation.id));
        return [...shown, ...page.operations.filter((operation) => !known.has(operation.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      if (generation !== listGeneration.current) return;
      // The cursor is kept, so the same button tries the same page again.
      toast.error(error instanceof Error ? error.message : 'More bootstrap runs could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore]);

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
  // A run that no longer exists (or a session that ended) will not come back on the next tick.
  const [pollStopped, setPollStopped] = useState(false);
  // Bumped after every poll, answered or not, so a long step that changes
  // nothing on the hub still gets the next tick.
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!open || !running || !operationId || pollStopped) return;
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
          setPollFailures(0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          // A failed poll keeps the last state on screen and counts toward the
          // notice; a run that is gone, or a session that ended, stops the polling.
          console.warn('Bootstrap progress could not be refreshed:', error);
          setPollFailures((count) => count + 1);
          const status = error instanceof BootstrapApiError ? error.code : '';
          if (status === 'OPERATION_NOT_FOUND' || status === 'HTTP_404' || status === 'HTTP_401') setPollStopped(true);
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
  }, [open, running, operationId, pollTick, pollStopped]);

  // A newly shown operation polls again.
  const [pollFor, setPollFor] = useState<string | null>(null);
  if (pollFor !== operationId) {
    setPollFor(operationId);
    setPollStopped(false);
  }

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
    listFailed,
    hasMoreOperations: nextCursor !== null,
    loadingMoreOperations: loadingMore,
    loadMore,
    /** Progress has not refreshed for three reads in a row, or the run can no longer be read. */
    progressStale: pollStopped || pollFailures >= 3,
    busy,
    show,
    openOperation,
    refreshList,
    cancel: () => act('cancel'),
    release: () => act('release'),
  };
}

export type UseBootstrapOperation = ReturnType<typeof useBootstrapOperation>;
