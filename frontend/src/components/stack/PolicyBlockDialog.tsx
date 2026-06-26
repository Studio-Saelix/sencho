import {
  Modal,
  ModalDestructiveHeader,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SeverityChip } from '@/components/VulnerabilityScanSheet';
import type { VulnSeverity } from '@/types/security';

/** Risk inputs a deploy gate can block on; mirrors the backend reason set. */
export type PolicyBlockReason = 'severity' | 'kev' | 'fixable';

export interface PolicyBlockViolation {
  imageRef: string;
  severity: VulnSeverity | string;
  criticalCount: number;
  highCount: number;
  kevCount: number;
  fixableCount: number;
  /** Which inputs matched (empty when the image could not be scanned). */
  reasons: PolicyBlockReason[];
  scanId: number;
  /** Set when the gate blocked because the image could not be scanned or
   *  evaluated (a scan/parse failure), rather than a policy input matching. */
  error?: string;
}

export interface PolicyBlockPayload {
  error: string;
  policy:
    | {
        id: number;
        name: string;
        maxSeverity: string;
        // Active inputs (0/1). Absent on older control payloads, where the
        // dialog falls back to severity-only wording.
        blockOnSeverity?: number;
        blockOnKev?: number;
        blockOnFixable?: number;
      }
    | null;
  violations: PolicyBlockViolation[];
}

const REASON_LABEL: Record<PolicyBlockReason, string> = {
  severity: 'Severity',
  kev: 'KEV',
  fixable: 'Fixable',
};

/** Plain-language list of the inputs a policy blocks on, for the dialog copy. */
function describePolicyInputs(policy: PolicyBlockPayload['policy']): string {
  if (!policy) return 'its scan policy conditions';
  const parts: string[] = [];
  if (policy.blockOnSeverity) parts.push(`severity at or above ${policy.maxSeverity}`);
  if (policy.blockOnKev) parts.push('a known-exploited CVE (KEV)');
  if (policy.blockOnFixable) parts.push('a fixable Critical/High finding');
  // Older payloads omit the flags entirely; describe the severity threshold.
  return parts.length > 0 ? parts.join(', ') : `severity at or above ${policy.maxSeverity}`;
}

/** The only stack operations the backend scan-policy gate can reject. */
export type PolicyBlockableAction = 'deploy' | 'update' | 'rollback';

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
  const inputsText = describePolicyInputs(payload?.policy ?? null);
  const violations = payload?.violations ?? [];

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onClose(); }} size="xl">
      <ModalDestructiveHeader
        kicker={`${stackName.toUpperCase()} · SCAN POLICY · BLOCKED`}
        title="Deploy blocked by security policy"
        description={`Policy ${policyName} blocks deploys on ${inputsText}.`}
      />
      <ModalBody>
        <p className="text-sm text-muted-foreground">
          Policy <span className="font-medium text-foreground">{policyName}</span> blocks deploys
          on <span className="font-medium text-foreground">{inputsText}</span>.{' '}
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
                  {v.error ? (
                    <>
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Could not be scanned
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 break-words">{v.error}</div>
                    </>
                  ) : (
                    <>
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle tabular-nums">
                        {v.criticalCount} critical &middot; {v.highCount} high
                        {v.kevCount > 0 && <> &middot; {v.kevCount} KEV</>}
                        {v.fixableCount > 0 && <> &middot; {v.fixableCount} fixable</>}
                      </div>
                      {(v.reasons ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {(v.reasons ?? []).map((r) => (
                            <Badge key={r} variant="destructive" className="text-[10px]">
                              {REASON_LABEL[r]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <SeverityChip severity={normalizeSeverity(String(v.severity))} />
              </div>
            ))
          )}
        </div>
        {violations.some((v) => v.error) && (
          <p className="text-sm text-muted-foreground mt-3">
            The deploy was blocked because the scan did not complete. Resolve the issue above and
            deploy again, or bypass if you accept the risk.
          </p>
        )}
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
