import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import {
  BootstrapApiError,
  cancelBootstrapOperation,
  fetchBootstrapOperation,
  listBootstrapOperations,
  releaseBootstrapOperation,
} from './bootstrapApi';
import { canSettleOnRead, isOperationRunning } from './operationStatus';
import type { BootstrapOperation, BootstrapOperationDetail } from './types';

/**
 * The bootstrap operation the dialog shows, and the recent ones it lists.
 *
 * The run lives on the hub, so this hook only reads it. While the shown
 * operation is running and the dialog is open, it is fetched again every two
 * seconds; a hidden tab skips the fetch. A run that stopped for good ends the
 * polling, but one the hub can still settle on a read (stopped partway, outcome
 * unknown, cancelled, with a node whose Pilot may connect late) is read every
 * few seconds, so the open dialog learns it became enrolled instead of offering
 * Retry and Release for a connected node. Nothing polls while the dialog is closed.
 */

export const OPERATION_POLL_MS = 2_000;
/** The slower read of a stopped run that may still be settled by a late Pilot. */
export const SETTLE_POLL_MS = 5_000;

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
  // Which rows the first page held at its last read, how many further pages "Show more" has added below it, and
  // the rows now shown: a settle read replaces the first page without dropping those further pages.
  const firstPageIds = useRef<Set<string>>(new Set());
  const extraPages = useRef(0);
  const operationsRef = useRef<BootstrapOperation[]>([]);
  // Consecutive failed progress reads for the shown run; reset by any answer.
  const [pollFailures, setPollFailures] = useState(0);
  const [busy, setBusy] = useState<OperationBusy>(null);
  // The shown operation's id, so a reply for one the operator has moved away
  // from is dropped instead of replacing the current view.
  const shownRef = useRef<string | null>(null);
  // Bumped whenever the shown operation is replaced by an answer the operator
  // caused (opening, retrying, cancelling, releasing). A progress read that began
  // before then is older than that answer and is dropped, so it cannot put the
  // previous state (a stopped run's Retry and Release) back on screen.
  const viewEpoch = useRef(0);

  const show = useCallback((detail: BootstrapOperationDetail | null) => {
    viewEpoch.current += 1;
    shownRef.current = detail?.id ?? null;
    setOperation(detail);
    setPollFailures(0);
  }, []);

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    listGeneration.current += 1;
    try {
      const page = await client.list(signal);
      listGeneration.current += 1;
      firstPageIds.current = new Set(page.operations.map((operation) => operation.id));
      extraPages.current = 0;
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
    void refreshList(controller.signal);
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
      extraPages.current += 1;
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

  /**
   * Read the list again for a settle poll. A plain re-read would put page one back and drop every page "Show more"
   * added, so those pages are kept: their rows that may still settle are read one by one, and an answer that was
   * overtaken by a page load or by another read of the list is dropped (the next tick tries again).
   */
  const refreshSettling = useCallback(async (signal: AbortSignal) => {
    if (extraPages.current === 0) {
      await refreshList(signal);
      return;
    }
    const generation = listGeneration.current;
    const pages = extraPages.current;
    try {
      const page = await client.list(signal);
      const firstIds = new Set(page.operations.map((operation) => operation.id));
      const before = firstPageIds.current;
      const tail = operationsRef.current.filter((operation) => !before.has(operation.id) && !firstIds.has(operation.id));
      const reread = new Map<string, BootstrapOperation>();
      await Promise.all(tail.filter(canSettleOnRead).map(async (operation) => {
        try {
          reread.set(operation.id, await client.get(operation.id, signal));
        } catch {
          // The row keeps what it showed; the next tick reads it again.
        }
      }));
      if (signal.aborted || generation !== listGeneration.current || pages !== extraPages.current) return;
      firstPageIds.current = firstIds;
      setOperations([...page.operations, ...tail.map((operation) => reread.get(operation.id) ?? operation)]);
      setListFailed(false);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('Bootstrap operations could not be listed:', error);
      setListFailed(true);
    }
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshList]);

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
  const settling = operation !== null && canSettleOnRead(operation);
  const polling = running || settling;
  const operationId = operation?.id ?? null;
  // A run that no longer exists (or a session that ended) will not come back on the next tick.
  const [pollStopped, setPollStopped] = useState(false);
  // Bumped after every poll, answered or not, so a long step that changes
  // nothing on the hub still gets the next tick.
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!open || !polling || !operationId || pollStopped) return;
    const controller = new AbortController();
    const epoch = viewEpoch.current;
    const timer = window.setTimeout(() => {
      // A hidden tab does not poll; the next visible tick picks the run up.
      if (document.hidden) {
        setPollTick((tick) => tick + 1);
        return;
      }
      void client.get(operationId, controller.signal)
        .then((detail) => {
          if (epoch !== viewEpoch.current) return;
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
    }, running ? OPERATION_POLL_MS : SETTLE_POLL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, polling, running, operationId, pollTick, pollStopped]);

  // The list is the other place a stopped run is shown. While no run is open and one of its rows may still be
  // settled by a late Pilot, it is read again, so a row does not keep offering Retry for a node that is enrolled.
  useEffect(() => { operationsRef.current = operations; }, [operations]);
  const listSettling = operation === null && operations.some(canSettleOnRead);
  const [listTick, setListTick] = useState(0);
  useEffect(() => {
    if (!open || !listSettling) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (document.hidden) {
        setListTick((tick) => tick + 1);
        return;
      }
      void refreshSettling(controller.signal).finally(() => {
        if (!controller.signal.aborted) setListTick((tick) => tick + 1);
      });
    }, SETTLE_POLL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // refreshSettling is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listSettling, listTick]);

  // A newly shown operation polls again.
  const [pollFor, setPollFor] = useState<string | null>(null);
  if (pollFor !== operationId) {
    setPollFor(operationId);
    setPollStopped(false);
  }

  const act = useCallback(async (kind: 'cancel' | 'release') => {
    if (!operationId) return;
    setBusy(kind);
    viewEpoch.current += 1;
    try {
      const detail = kind === 'cancel' ? await client.cancel(operationId) : await client.release(operationId);
      viewEpoch.current += 1;
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
    /** The shown run has stopped but the hub may still settle it (a Pilot that connects late). */
    settling,
    busy,
    show,
    openOperation,
    refreshList,
    cancel: () => act('cancel'),
    release: () => act('release'),
  };
}

export type UseBootstrapOperation = ReturnType<typeof useBootstrapOperation>;
