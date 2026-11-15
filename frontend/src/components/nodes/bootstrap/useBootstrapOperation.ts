import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import {
  BootstrapApiError,
  cancelBootstrapOperation,
  fetchBootstrapOperation,
  listBootstrapOperations,
  releaseBootstrapOperation,
  verifyBootstrapOperation,
} from './bootstrapApi';
import { awaitsReadiness, canSettleOnRead, isOperationRunning } from './operationStatus';
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
 * Retry and Release for a connected node. An enrolled run whose node the hub has
 * not finished checking for readiness is read at the same slower pace, so the
 * verdict appears without a reload, and so is a listed one. A verdict that was
 * already in is not final: the hub announces every change of a node's readiness
 * (a dropped tunnel, a new check), and the open dialog then reads the shown
 * enrolled run, or the listed enrolled runs, once more, and so does the
 * notification socket coming back after a drop (announcements sent while it was
 * down are lost), so a node that stopped being ready is not still called ready. Nothing polls while the dialog is closed.
 */

export const OPERATION_POLL_MS = 2_000;
/** The slower read of a stopped run that may still be settled by a late Pilot. */
export const SETTLE_POLL_MS = 5_000;
/** How long a burst of readiness announcements is gathered before the open views are read once. */
export const READINESS_REFRESH_DELAY_MS = 500;

export interface UseBootstrapOperationOptions {
  open: boolean;
  api?: {
    get: typeof fetchBootstrapOperation;
    list: typeof listBootstrapOperations;
    cancel: typeof cancelBootstrapOperation;
    release: typeof releaseBootstrapOperation;
    verify?: typeof verifyBootstrapOperation;
  };
}

type OperationBusy = 'open' | 'cancel' | 'release' | 'verify' | null;

export function useBootstrapOperation({ open, api }: UseBootstrapOperationOptions) {
  const client = api ?? {
    get: fetchBootstrapOperation,
    list: listBootstrapOperations,
    cancel: cancelBootstrapOperation,
    release: releaseBootstrapOperation,
    verify: verifyBootstrapOperation,
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
  // Reads of the shown run's detail overlap (a poll and a readiness read). Each takes a number when it starts, and an
  // answer older than one already applied is dropped, so a slow earlier read cannot bring back a verdict a later one replaced.
  const detailReadSeq = useRef(0);
  const detailAppliedSeq = useRef(0);
  // The same rule for reads of the list (a settle read and a readiness read).
  const listReadSeq = useRef(0);
  const listAppliedSeq = useRef(0);
  const operationRef = useRef<BootstrapOperationDetail | null>(null);
  // A readiness read of the shown run failed: what is on screen may be stale, so it is read again until one answers.
  const [readinessReadFailed, setReadinessReadFailed] = useState(false);
  // The same for the list: a readiness read of it failed or was overtaken, so its rows are read again until one applies.
  const [listReadPending, setListReadPending] = useState(false);

  const show = useCallback((detail: BootstrapOperationDetail | null) => {
    viewEpoch.current += 1;
    shownRef.current = detail?.id ?? null;
    operationRef.current = detail;
    setOperation(detail);
    setPollFailures(0);
    setReadinessReadFailed(false);
  }, []);

  /** Put an answer for the shown run on screen. Every write of the shown run goes through here, so the ref cannot drift from the state. */
  const apply = useCallback((detail: BootstrapOperationDetail) => {
    operationRef.current = detail;
    setOperation(detail);
  }, []);

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    listGeneration.current += 1;
    const seq = ++listReadSeq.current;
    try {
      const page = await client.list(signal);
      // A settle read that started after this one and already answered is newer than this answer.
      if (seq < listAppliedSeq.current) return;
      listAppliedSeq.current = seq;
      setListReadPending(false);
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
   * added, so those pages are kept. A run that fell off the first page (a newer hold pushed it down, or it was
   * released) and a run on a later page that may still settle are read one by one. An answer that a page load or another
   * read of the list overtook is dropped (the next tick tries again); the read itself never invalidates a page load in flight.
   */
  const refreshSettling = useCallback(async (signal: AbortSignal, readinessChanged = false): Promise<boolean> => {
    const pages = extraPages.current;
    const generation = listGeneration.current;
    const seq = ++listReadSeq.current;
    try {
      const page = await client.list(signal);
      const firstIds = new Set(page.operations.map((operation) => operation.id));
      const before = firstPageIds.current;
      const tail = pages === 0
        ? []
        : operationsRef.current.filter((operation) => !firstIds.has(operation.id));
      const reread = new Map<string, BootstrapOperation>();
      // A row on a later page is read one by one when it was on page one, may still be settled by a late Pilot, awaits its
      // first verdict, or (after a readiness announcement) is enrolled, since its verdict may have changed.
      await Promise.all(tail.filter((operation) => before.has(operation.id) || canSettleOnRead(operation) || awaitsReadiness(operation)
        || (readinessChanged && operation.state === 'enrolled')).map(async (operation) => {
        try {
          reread.set(operation.id, await client.get(operation.id, signal));
        } catch {
          // The row keeps what it showed; the next tick reads it again.
        }
      }));
      // Another read of the list (open, release, cancel) overtook this one, a page was loaded meanwhile, or a newer read of
      // these rows already answered.
      if (signal.aborted || generation !== listGeneration.current || pages !== extraPages.current || seq < listAppliedSeq.current) return false;
      listAppliedSeq.current = seq;
      firstPageIds.current = firstIds;
      const kept = tail
        .map((operation) => reread.get(operation.id) ?? operation)
        // A run that was on the first page and no longer holds its server has left the list of holds.
        .filter((operation) => operation.active || !before.has(operation.id));
      setOperations([...page.operations, ...kept]);
      if (pages === 0) setNextCursor(page.nextCursor);
      setListFailed(false);
      return true;
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      console.warn('Bootstrap operations could not be listed:', error);
      setListFailed(true);
      return false;
    }
    // client.* is stable module API unless a test injects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const polling = running || settling || readinessReadFailed || (operation !== null && awaitsReadiness(operation));
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
      const seq = ++detailReadSeq.current;
      void client.get(operationId, controller.signal)
        .then((detail) => {
          if (epoch !== viewEpoch.current || seq < detailAppliedSeq.current) return;
          detailAppliedSeq.current = seq;
          if (shownRef.current === detail.id) apply(detail);
          setPollFailures(0);
          setReadinessReadFailed(false);
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
  const listSettling = operation === null && (listReadPending || operations.some((entry) => canSettleOnRead(entry) || awaitsReadiness(entry)));
  const [listTick, setListTick] = useState(0);
  useEffect(() => {
    if (!open || !listSettling) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (document.hidden) {
        setListTick((tick) => tick + 1);
        return;
      }
      void refreshSettling(controller.signal, listReadPending).then((applied) => {
        if (applied && listReadPending) setListReadPending(false);
      }).finally(() => {
        if (!controller.signal.aborted) setListTick((tick) => tick + 1);
      });
    }, SETTLE_POLL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // refreshSettling is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listSettling, listTick, listReadPending]);

  // The hub announces every change of a node's readiness. A verdict already on screen is then read again: the shown
  // enrolled run once, and, when no run is shown, the listed enrolled runs (and loaded later pages' enrolled rows) once.
  // Announcements within one window share the read; the events say nothing a read would not, so an announcement for
  // another node costs one read and changes nothing on screen.
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const readNow = async () => {
      const shown = operationRef.current;
      if (shown) {
        if (shown.state !== 'enrolled') return;
        const epoch = viewEpoch.current;
        const seq = ++detailReadSeq.current;
        try {
          const detail = await client.get(shown.id, controller.signal);
          if (epoch !== viewEpoch.current || seq < detailAppliedSeq.current || shownRef.current !== detail.id) return;
          detailAppliedSeq.current = seq;
          apply(detail);
          setPollFailures(0);
          setReadinessReadFailed(false);
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          // What is on screen may be stale. The shown run is read again on the slower pace until one read answers.
          console.warn('Bootstrap readiness could not be refreshed:', error);
          if (epoch === viewEpoch.current) setReadinessReadFailed(true);
        }
        return;
      }
      if (operationsRef.current.some((entry) => entry.state === 'enrolled')) {
        // A read that failed or was overtaken is read again on the slower pace until one applies.
        const applied = await refreshSettling(controller.signal, true);
        if (!applied && !controller.signal.aborted) setListReadPending(true);
      }
    };
    const onInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: unknown }>).detail;
      if (detail?.scope !== 'node-readiness' || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void readNow();
      }, READINESS_REFRESH_DELAY_MS);
    };
    // Announcements sent while the notification socket was down are lost (a hub restart puts every ready node back to
    // unverified without any socket to say so), so the socket coming back reads the same views once.
    let socketWasDown = false;
    const onConnection = (event: Event) => {
      const connected = (event as CustomEvent<{ connected?: unknown }>).detail?.connected;
      if (connected === false) {
        socketWasDown = true;
      } else if (connected === true && socketWasDown) {
        socketWasDown = false;
        void readNow();
      }
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    window.addEventListener('sencho:notifications-connection', onConnection);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      window.removeEventListener('sencho:notifications-connection', onConnection);
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
    // client.* is stable module API unless a test injects it; apply and refreshSettling are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A newly shown operation polls again.
  const [pollFor, setPollFor] = useState<string | null>(null);
  if (pollFor !== operationId) {
    setPollFor(operationId);
    setPollStopped(false);
  }

  const act = useCallback(async (kind: 'cancel' | 'release' | 'verify') => {
    if (!operationId) return;
    setBusy(kind);
    viewEpoch.current += 1;
    try {
      const verify = client.verify ?? verifyBootstrapOperation;
      const detail = kind === 'cancel'
        ? await client.cancel(operationId)
        : kind === 'release' ? await client.release(operationId) : await verify(operationId);
      viewEpoch.current += 1;
      if (shownRef.current === detail.id) apply(detail);
      if (kind === 'release') toast.success('Server released. Nothing on it was changed.');
      void refreshList();
    } catch (error: unknown) {
      const verb = kind === 'cancel' ? 'cancelled' : kind === 'release' ? 'released' : 'checked for readiness';
      toast.error(error instanceof Error ? error.message : `The bootstrap could not be ${verb}.`);
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
    verify: () => act('verify'),
  };
}

export type UseBootstrapOperation = ReturnType<typeof useBootstrapOperation>;
