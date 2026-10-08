import { useCallback, useState, type ReactNode } from 'react';
import { toast } from '@/components/ui/toast-store';
import { ConfirmModal } from '@/components/ui/modal';
import { apiFetch, fetchForNode } from '@/lib/api';
import { fetchFleetSyncStatuses, resetFleetSyncAnchor } from '@/lib/fleetSyncApi';
import { backupStack, startStack } from '@/lib/stackLifecycleApi';
import { useStackUpdate } from '@/hooks/useStackUpdate';
import { UpdateReadinessDialog } from '@/components/stack/UpdateReadinessDialog';
import type { ReadinessFinding } from '@/types/readiness';
import { resolveVerb, type ReadinessVerb } from './readinessVerbs';

/** What a row needs to draw and run its resolving verb. */
export interface FindingVerbControl {
  label: string;
  busy: boolean;
  run: () => void;
}

interface UseReadinessVerbsOptions {
  /** Re-reads the hub's check, so a resolved finding leaves the list. */
  recheck: () => void;
  /** Opens the finding's own surface; the follow-up action when a verb finds nothing to run. */
  openFinding: (finding: ReadinessFinding) => void;
  /** Whether this account may run the verb; a verb it may not run is not offered. */
  canRun: (verb: ReadinessVerb, finding: ReadinessFinding) => boolean;
  nodeName: (nodeId: number) => string;
}

type Confirming =
  | { verb: 'install-scanner'; finding: ReadinessFinding }
  /** `anchor`: undefined while it is being read, null when the node records none, else its short fingerprint. */
  | { verb: 'reanchor'; finding: ReadinessFinding; anchor: string | null | undefined; unreadable: boolean };

async function serverMessage(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error !== ''
    ? body.error
    : fallback;
}

/** Images and stacks a node scan could not scan, from its reply. */
function scanFailureCount(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const failed = (part: unknown): number => (
    typeof part === 'object' && part !== null && 'failed' in part && typeof part.failed === 'number' ? part.failed : 0
  );
  return failed('images' in result ? result.images : null) + failed('stacks' in result ? result.stacks : null);
}

/** The first characters of a control fingerprint: enough to tell two hubs apart on a confirm. */
function shortAnchor(fingerprint: string | null): string | null {
  return fingerprint === null || fingerprint === '' ? null : fingerprint.slice(0, 12);
}

/**
 * Runs the verbs that resolve a readiness finding where it is listed.
 *
 * Node-scoped verbs (start, backup, scan, install, update) are addressed to the
 * finding's own node, never the node the operator happens to have selected;
 * fleet-wide ones run on the hub. Anything consequential (an update, an
 * install, a re-anchor) goes through an overlay first, so a safe action is one
 * click and a consequential one is two.
 */
export function useReadinessVerbs({ recheck, openFinding, canRun, nodeName }: UseReadinessVerbsOptions) {
  const updateStack = useStackUpdate();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewing, setReviewing] = useState<ReadinessFinding | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const track = useCallback(async (finding: ReadinessFinding, work: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(finding.id));
    try {
      await work();
    } finally {
      setBusy(prev => {
        const next = new Set(prev);
        next.delete(finding.id);
        return next;
      });
    }
  }, []);

  const runStackVerb = useCallback((finding: ReadinessFinding, verb: 'start' | 'backup') => track(finding, async () => {
    const stack = finding.stack;
    if (stack === null) {
      // resolveVerb only offers a stack verb on a finding that names a stack.
      console.error('Readiness stack verb on a finding with no stack:', finding.id);
      openFinding(finding);
      return;
    }
    try {
      const result = verb === 'start' ? await startStack(finding.nodeId, stack) : await backupStack(finding.nodeId, stack);
      if (result.ok) {
        toast.success(verb === 'start' ? `Started ${stack}` : `Captured a recovery point for ${stack}`);
        recheck();
      } else if (result.reason === 'no-containers') {
        // Nothing to start: its containers are gone, and recreating them is a deploy.
        toast.error(`${stack} has no containers to start.`, {
          action: { label: 'Open stack', onClick: () => openFinding(finding) },
        });
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('Readiness stack verb failed:', error);
      toast.error(error instanceof Error ? error.message : `Could not ${verb} ${stack}`);
    }
  }), [openFinding, recheck, track]);

  const testConnection = useCallback((finding: ReadinessFinding) => track(finding, async () => {
    const name = nodeName(finding.nodeId);
    try {
      // Hub-held node record, so the test is addressed to this instance.
      const res = await apiFetch(`/nodes/${finding.nodeId}/test`, { method: 'POST', localOnly: true });
      const body: unknown = await res.json().catch(() => null);
      const outcome = typeof body === 'object' && body !== null ? body as { success?: unknown; error?: unknown } : {};
      const reason = typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : null;
      if (res.ok && outcome.success === true) toast.success(`Connected to "${name}"`);
      else if (!res.ok) toast.error(reason ?? `Connection test failed (HTTP ${res.status})`);
      else toast.error(reason ?? `Could not reach "${name}"`);
      recheck();
    } catch (error) {
      console.error('Readiness connection test failed:', error);
      toast.error(error instanceof Error ? error.message : `Could not test "${name}"`);
    }
  }), [nodeName, recheck, track]);

  const takeSnapshot = useCallback((finding: ReadinessFinding) => track(finding, async () => {
    try {
      const res = await apiFetch('/fleet/snapshots', { method: 'POST', localOnly: true, body: JSON.stringify({}) });
      if (res.ok) {
        toast.success('Fleet snapshot captured');
        recheck();
      } else {
        toast.error(await serverMessage(res, 'Could not capture a fleet snapshot'));
      }
    } catch (error) {
      console.error('Readiness snapshot failed:', error);
      toast.error(error instanceof Error ? error.message : 'Could not capture a fleet snapshot');
    }
  }), [recheck, track]);

  const scanNode = useCallback((finding: ReadinessFinding) => track(finding, async () => {
    const name = nodeName(finding.nodeId);
    toast.info(`Scanning "${name}". This can take a few minutes.`);
    try {
      const res = await fetchForNode('/security/scan-node', finding.nodeId, {
        method: 'POST',
        body: JSON.stringify({ vulns: true, secrets: true, misconfig: true }),
      });
      if (res.ok) {
        // A 200 can still carry per-image or per-stack failures; a partial scan must not read as clean.
        const result: unknown = await res.json().catch(() => null);
        const failed = scanFailureCount(result);
        if (failed > 0) toast.warning(`Scan of "${name}" finished with ${failed} failure${failed === 1 ? '' : 's'}.`);
        else toast.success(`Scan of "${name}" finished`);
        recheck();
      } else {
        toast.error(await serverMessage(res, `Scan of "${name}" failed`));
      }
    } catch (error) {
      console.error('Readiness node scan failed:', error);
      toast.error(error instanceof Error ? error.message : `Scan of "${name}" failed`);
    }
  }), [nodeName, recheck, track]);

  const run = useCallback((verb: ReadinessVerb, finding: ReadinessFinding): void => {
    switch (verb.id) {
      case 'test-connection': void testConnection(finding); return;
      case 'start-stack':
      case 'start-services': void runStackVerb(finding, 'start'); return;
      case 'capture-recovery': void runStackVerb(finding, 'backup'); return;
      case 'check-again': recheck(); return;
      case 'take-snapshot': void takeSnapshot(finding); return;
      case 'scan-node': void scanNode(finding); return;
      case 'review-update': setReviewing(finding); return;
      case 'install-scanner': setConfirming({ verb: 'install-scanner', finding }); return;
      case 'reanchor':
        setConfirming({ verb: 'reanchor', finding, anchor: undefined, unreadable: false });
        fetchFleetSyncStatuses()
          .then(statuses => {
            // A node has one row per synced resource; the paused one is the row that names the anchor.
            const expected = statuses.find(status => status.node_id === finding.nodeId && status.sticky_error_expected !== null)
              ?.sticky_error_expected ?? null;
            setConfirming(current => (current?.verb === 'reanchor' && current.finding.id === finding.id
              ? { ...current, anchor: shortAnchor(expected) }
              : current));
          })
          .catch((error: unknown) => {
            // The confirm still works without the name, and says it could not be read.
            console.error('Could not read the current anchor:', error);
            setConfirming(current => (current?.verb === 'reanchor' && current.finding.id === finding.id
              ? { ...current, anchor: null, unreadable: true }
              : current));
          });
        return;
      default: {
        const unhandled: never = verb.id;
        console.error('Readiness verb has no runner:', unhandled);
      }
    }
  }, [recheck, runStackVerb, scanNode, takeSnapshot, testConnection]);

  /** The verb to draw on this finding's row, or null to keep its named navigation. */
  const verbFor = useCallback((finding: ReadinessFinding): FindingVerbControl | null => {
    const verb = resolveVerb(finding);
    if (verb === null || !canRun(verb, finding)) return null;
    return { label: verb.label, busy: busy.has(finding.id), run: () => run(verb, finding) };
  }, [busy, canRun, run]);

  const confirmAction = useCallback(async () => {
    if (confirming === null) return;
    const { finding } = confirming;
    const name = nodeName(finding.nodeId);
    setConfirmBusy(true);
    try {
      if (confirming.verb === 'install-scanner') {
        const res = await fetchForNode('/security/trivy-install', finding.nodeId, { method: 'POST' });
        if (!res.ok) {
          toast.error(await serverMessage(res, `Could not install the scanner on "${name}"`));
          return;
        }
        toast.success(`Scanner installed on "${name}"`);
      } else {
        await resetFleetSyncAnchor(finding.nodeId);
        toast.success(`"${name}" now follows this hub`);
      }
      setConfirming(null);
      recheck();
    } catch (error) {
      console.error('Readiness confirm verb failed:', error);
      toast.error(error instanceof Error ? error.message : 'The action failed');
    } finally {
      setConfirmBusy(false);
    }
  }, [confirming, nodeName, recheck]);

  let confirmDescription: string | undefined;
  if (confirming?.verb === 'reanchor') {
    const anchorNote = confirming.anchor ? ` (${confirming.anchor})` : '';
    const unreadableNote = confirming.unreadable ? ' (which hub could not be read)' : '';
    confirmDescription = `"${nodeName(confirming.finding.nodeId)}" is anchored to a different hub${anchorNote}${unreadableNote}. Re-anchoring makes this hub the one that pushes policy to it.`;
  } else if (confirming?.verb === 'install-scanner') {
    confirmDescription = `Downloads the vulnerability scanner onto "${nodeName(confirming.finding.nodeId)}" so it can scan images and stacks.`;
  }

  const reviewingStack = reviewing?.stack ?? null;
  const overlays: ReactNode = (
    <>
      {reviewing !== null && reviewingStack !== null && (
        <UpdateReadinessDialog
          open
          stackName={reviewingStack}
          nodeId={reviewing.nodeId}
          onCancel={() => setReviewing(null)}
          onProceed={() => {
            const target = reviewing;
            setReviewing(null);
            void track(target, async () => {
              await updateStack({ nodeId: target.nodeId, stackName: reviewingStack });
              // A refused or failed update can still have changed what the check sees.
              recheck();
            });
          }}
        />
      )}
      <ConfirmModal
        open={confirming !== null}
        onOpenChange={open => { if (!open) setConfirming(null); }}
        kicker={confirming?.verb === 'reanchor' ? 'fleet · policy sync' : 'security · scanner'}
        title={confirming?.verb === 'reanchor' ? 'Re-anchor to this hub?' : 'Install the scanner?'}
        description={confirmDescription}
        confirmLabel={confirming?.verb === 'reanchor' ? 'Re-anchor' : 'Install'}
        confirming={confirmBusy}
        confirmDisabled={confirming?.verb === 'reanchor' && confirming.anchor === undefined}
        onConfirm={confirmAction}
      />
    </>
  );

  return { verbFor, overlays };
}
