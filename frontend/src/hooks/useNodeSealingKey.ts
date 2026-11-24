import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

/** Whether a remote node can receive a sealed secret, as the control instance sees it. */
export type SealingKeyReadiness = 'ready' | 'unsupported' | 'unreachable' | 'key_invalid' | 'pin_unconfirmed' | 'key_mismatch';

const READINESS: ReadonlySet<string> = new Set<SealingKeyReadiness>([
  'ready', 'unsupported', 'unreachable', 'key_invalid', 'pin_unconfirmed', 'key_mismatch',
]);

function isPin(value: unknown): value is SealingKeyPin {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.fingerprint === 'string'
    && typeof raw.registeredAt === 'number'
    && typeof raw.confidential === 'boolean'
    && (raw.confirmedBy === null || typeof raw.confirmedBy === 'string')
    && (raw.confirmedAt === null || typeof raw.confirmedAt === 'number');
}

/** Narrow a sealing key status answer; anything else is an answer this build cannot show. */
export function parseNodeSealingKeyView(value: unknown): NodeSealingKeyView {
  const fail = (): never => { throw new Error('The control instance answered with a sealing key status this page cannot show. Reload the page.'); };
  if (typeof value !== 'object' || value === null) return fail();
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'local') {
    return typeof raw.fingerprint === 'string' ? { kind: 'local', fingerprint: raw.fingerprint } : fail();
  }
  if (raw.kind !== 'remote' || typeof raw.readiness !== 'string' || !READINESS.has(raw.readiness)) return fail();
  if (raw.pinned !== null && !isPin(raw.pinned)) return fail();
  const presented = raw.presented as { fingerprint?: unknown } | null;
  if (presented !== null && (typeof presented !== 'object' || typeof presented.fingerprint !== 'string')) return fail();
  return {
    kind: 'remote',
    readiness: raw.readiness as SealingKeyReadiness,
    pinned: raw.pinned as SealingKeyPin | null,
    presented: presented === null ? null : { fingerprint: presented.fingerprint as string },
  };
}

export interface SealingKeyPin {
  fingerprint: string;
  registeredAt: number;
  /** Pinned or re-confirmed over a confidential connection, or confirmed by an Admin. */
  confidential: boolean;
  confirmedBy: string | null;
  confirmedAt: number | null;
}

export type NodeSealingKeyView =
  | { kind: 'local'; fingerprint: string }
  | {
    kind: 'remote';
    readiness: SealingKeyReadiness;
    pinned: SealingKeyPin | null;
    presented: { fingerprint: string } | null;
  };

export type SealingKeyPending = 'confirm' | 'reset' | 'reload' | null;

interface SealingKeyAnswerState {
  nodeId: number | null;
  view: NodeSealingKeyView | null;
  loadError: string | null;
  readAt: number | null;
}

const EMPTY_ANSWER: SealingKeyAnswerState = { nodeId: null, view: null, loadError: null, readAt: null };

interface ErrorBody {
  error?: string;
  code?: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({})) as ErrorBody;
  return body.error || fallback;
}

/**
 * Clear a node's sealing key pin. The one request behind every Reset pin
 * affordance (the Nodes row and the Sealing key sheet); each caller words
 * its own toast. Throws with the server's message on failure.
 */
export async function resetNodeSealingKeyPin(nodeId: number): Promise<void> {
  const res = await apiFetch(`/nodes/${nodeId}/sealing-key`, {
    method: 'DELETE',
    localOnly: true,
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to reset sealing key pin'));
  }
}

export interface NodeSealingKey {
  view: NodeSealingKeyView | null;
  /** True only until the first answer; a refetch keeps the last view on screen. */
  loading: boolean;
  /** Why the last fetch failed; the view on screen (if any) may be out of date. */
  loadError: string | null;
  /** When the view on screen was read. */
  readAt: number | null;
  pending: SealingKeyPending;
  reload: () => Promise<void>;
  /** Resolves to true when the fingerprint was confirmed. */
  confirm: (fingerprint: string) => Promise<boolean>;
  /** Resolves to true when the pin was cleared. */
  reset: () => Promise<boolean>;
}

/**
 * The one shared hook behind the Sealing key sheet: it reads the node's
 * sealing key status and runs Confirm fingerprint and Reset pin. It fetches
 * while `enabled` (the sheet is open) and never polls; the status read makes
 * a live call to the node, so it runs only on demand.
 */
export function useNodeSealingKey(
  node: { id: number; name: string } | null,
  enabled: boolean,
  onPinCleared?: () => void,
): NodeSealingKey {
  const nodeId = node?.id ?? null;
  const nodeName = node?.name ?? '';
  // Answers are stored with the node they belong to, so switching nodes shows
  // nothing from the previous node without resetting state in an effect.
  const [answer, setAnswer] = useState<SealingKeyAnswerState>(EMPTY_ANSWER);
  const [pending, setPending] = useState<SealingKeyPending>(null);
  const mounted = useRef(true);
  // The node the sheet shows now; an answer for another node is dropped.
  const currentNode = useRef<number | null>(nodeId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    currentNode.current = nodeId;
  }, [nodeId]);

  const adopt = useCallback((id: number, next: NodeSealingKeyView) => {
    setAnswer({ nodeId: id, view: next, loadError: null, readAt: Date.now() });
  }, []);

  const load = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/nodes/${id}/sealing-key`, { localOnly: true });
      if (!res.ok) throw new Error(await readError(res, 'Could not read the sealing key status.'));
      const next = parseNodeSealingKeyView(await res.json());
      if (!mounted.current || currentNode.current !== id) return;
      adopt(id, next);
    } catch (error: unknown) {
      if (!mounted.current || currentNode.current !== id) return;
      const message = (error as Error)?.message || 'Could not read the sealing key status.';
      // A failed refetch keeps the last view for this node and says why.
      setAnswer((prev) => (prev.nodeId === id
        ? { ...prev, loadError: message }
        : { nodeId: id, view: null, loadError: message, readAt: null }));
    }
  }, [adopt]);

  useEffect(() => {
    if (!enabled || nodeId === null) return;
    // `load` sets state only after its request resolves, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(nodeId);
  }, [enabled, nodeId, load]);

  const reload = useCallback(async () => {
    if (nodeId === null) return;
    setPending('reload');
    try {
      await load(nodeId);
    } finally {
      if (mounted.current) setPending(null);
    }
  }, [load, nodeId]);

  const mine = answer.nodeId === nodeId ? answer : EMPTY_ANSWER;
  const view = mine.view;
  const loadError = mine.loadError;
  const readAt = mine.readAt;
  // Only a first read with nothing to show yet counts as loading.
  const loading = enabled && nodeId !== null && view === null && loadError === null;

  const confirm = useCallback(async (fingerprint: string): Promise<boolean> => {
    if (nodeId === null) return false;
    setPending('confirm');
    try {
      const res = await apiFetch(`/nodes/${nodeId}/sealing-key/confirm`, {
        method: 'POST',
        localOnly: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Could not confirm the fingerprint.'));
      const next = parseNodeSealingKeyView(await res.json());
      if (mounted.current && currentNode.current === nodeId) adopt(nodeId, next);
      toast.success(`Fingerprint confirmed for "${nodeName}". Sealed secrets can now be sent to it.`);
      return true;
    } catch (error: unknown) {
      const e = error as { message?: string; error?: string; data?: { error?: string } } | null;
      toast.error(e?.message || e?.error || e?.data?.error || 'Could not confirm the fingerprint.');
      // The node may have changed its key or gone away; show what is true now.
      if (mounted.current && currentNode.current === nodeId) void load(nodeId);
      return false;
    } finally {
      if (mounted.current) setPending(null);
    }
  }, [nodeId, nodeName, adopt, load]);

  const reset = useCallback(async (): Promise<boolean> => {
    if (nodeId === null) return false;
    setPending('reset');
    try {
      await resetNodeSealingKeyPin(nodeId);
      toast.success(`Sealing key pin cleared for "${nodeName}". The next contact pins the key the node presents.`);
      onPinCleared?.();
      if (mounted.current && currentNode.current === nodeId) await load(nodeId);
      return true;
    } catch (error: unknown) {
      const e = error as { message?: string; error?: string; data?: { error?: string } } | null;
      toast.error(e?.message || e?.error || e?.data?.error || 'Failed to reset sealing key pin');
      return false;
    } finally {
      if (mounted.current) setPending(null);
    }
  }, [nodeId, nodeName, load, onPinCleared]);

  return { view, loading, loadError, readAt, pending, reload, confirm, reset };
}
