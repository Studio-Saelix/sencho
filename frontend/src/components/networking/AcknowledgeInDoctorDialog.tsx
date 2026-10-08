import { useState } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import type { NetworkingFinding } from '@/types/networking';

interface AcknowledgeInDoctorDialogProps {
  finding: NetworkingFinding | null;
  nodeId: number | undefined;
  onClose: () => void;
  /** At least one acknowledgement was written, so the list should be re-read. */
  onDone: () => void;
}

async function serverMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error !== ''
    ? body.error
    : 'Failed to acknowledge the finding.';
}

/**
 * Acknowledges a Doctor-only finding in Compose Doctor. It is a confirm and not a
 * one-click dismiss because an acknowledgement is Doctor's, and it changes the
 * stack's update readiness: Doctor stops counting the finding there too. It
 * holds until the stack's Compose file changes.
 */
export function AcknowledgeInDoctorDialog({ finding, nodeId, onClose, onDone }: AcknowledgeInDoctorDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const open = finding !== null;
  const unacknowledged = finding?.doctorFindings.filter(entry => entry.acknowledgement === undefined) ?? [];
  const rules = [...new Set(unacknowledged.map(entry => entry.ruleId))];

  const confirm = async (): Promise<void> => {
    if (finding?.stack === undefined) return;
    setConfirming(true);
    let written = 0;
    try {
      for (const entry of unacknowledged) {
        const res = await apiFetch(`/stacks/${encodeURIComponent(finding.stack)}/preflight/acknowledgements`, {
          method: 'POST',
          nodeId,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ruleId: entry.ruleId,
            ...(entry.service ? { service: entry.service } : {}),
            expiryMode: 'until_compose_change',
          }),
        });
        if (!res.ok) {
          console.error('[Networking] acknowledgement refused:', res.status);
          toast.error(await serverMessage(res));
          return;
        }
        written += 1;
      }
      toast.success('Acknowledged in Compose Doctor.');
      onClose();
    } catch (error) {
      console.error('[Networking] acknowledgement failed:', error);
      toast.error('Failed to acknowledge the finding.');
    } finally {
      setConfirming(false);
      if (written > 0) onDone();
    }
  };

  return (
    <ConfirmModal
      open={open}
      onOpenChange={next => { if (!next) onClose(); }}
      kicker="NETWORKING · COMPOSE DOCTOR · ACKNOWLEDGE"
      title="Acknowledge in Compose Doctor"
      description={finding?.stack === undefined ? undefined : `Stack ${finding.stack}`}
      confirmLabel="Acknowledge"
      confirming={confirming}
      confirmDisabled={unacknowledged.length === 0}
      onConfirm={confirm}
    >
      <div className="space-y-2 text-sm text-stat-subtitle">
        <p>
          This records an acknowledgement in Compose Doctor for{' '}
          {rules.map((rule, index) => (
            <span key={rule}>
              {index > 0 && ', '}
              <span className="font-mono text-stat-value">{rule}</span>
            </span>
          ))}.
          It holds until the Compose file changes.
        </p>
        <p>It also changes update readiness for this stack: Compose Doctor stops counting the finding there.</p>
      </div>
    </ConfirmModal>
  );
}
