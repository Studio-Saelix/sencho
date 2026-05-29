import {
  Modal,
  ModalDestructiveHeader,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { SeverityChip } from '@/components/VulnerabilityScanSheet';
import type { VulnSeverity } from '@/types/security';

export interface PolicyBlockViolation {
  imageRef: string;
  severity: VulnSeverity | string;
  criticalCount: number;
  highCount: number;
  scanId: number;
}

export interface PolicyBlockPayload {
  error: string;
  policy: { id: number; name: string; maxSeverity: string } | null;
  violations: PolicyBlockViolation[];
}

/** The only stack operations the backend scan-policy gate can reject. */
export type PolicyBlockableAction = 'deploy' | 'update';

interface PolicyBlockDialogProps {
  open: boolean;
  payload: PolicyBlockPayload | null;
  stackName: string;
  canBypass: boolean;
  bypassing: boolean;
  onClose: () => void;
  onBypass: () => void;
}

const KNOWN_SEVERITIES: VulnSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function normalizeSeverity(value: string): VulnSeverity {
  const upper = value.toUpperCase();
  return (KNOWN_SEVERITIES as string[]).includes(upper) ? (upper as VulnSeverity) : 'UNKNOWN';
}

export function PolicyBlockDialog({
  open,
  payload,
  stackName,
  canBypass,
  bypassing,
  onClose,
  onBypass,
}: PolicyBlockDialogProps) {
  const policyName = payload?.policy?.name ?? 'policy';
  const maxSeverity = payload?.policy?.maxSeverity ?? '';
  const violations = payload?.violations ?? [];

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onClose(); }} size="xl">
      <ModalDestructiveHeader
        kicker={`${stackName.toUpperCase()} · SCAN POLICY · BLOCKED`}
        title="Deploy blocked by security policy"
        description={`Policy ${policyName} blocks deploys when any image meets or exceeds ${maxSeverity}.`}
      />
      <ModalBody>
        <p className="text-sm text-muted-foreground">
          Policy <span className="font-medium text-foreground">{policyName}</span> blocks deploys
          when any image meets or exceeds{' '}
          <span className="font-medium text-foreground">{maxSeverity}</span>.{' '}
          The following {violations.length === 1 ? 'image' : `${violations.length} images`} triggered the block.
        </p>
        <div className="border border-glass-border bg-card/60 shadow-card-bevel divide-y divide-glass-border">
          {violations.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              No violation details were returned. Check the scan history for this stack for more context.
            </div>
          ) : (
            violations.map((v) => (
              <div key={`${v.imageRef}-${v.scanId}`} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-sm truncate">{v.imageRef}</div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle tabular-nums">
                    {v.criticalCount} critical &middot; {v.highCount} high
                  </div>
                </div>
                <SeverityChip severity={normalizeSeverity(String(v.severity))} />
              </div>
            ))
          )}
        </div>
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        }
        primary={
          canBypass ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={bypassing}
              onClick={(e) => {
                e.preventDefault();
                onBypass();
              }}
            >
              {bypassing ? 'Deploying…' : 'Deploy anyway'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Admin required to bypass
            </Button>
          )
        }
      />
    </Modal>
  );
}
