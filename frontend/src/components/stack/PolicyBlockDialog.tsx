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
import { buildEvidenceLines } from './policyBlockEvidence';

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

/** One configured rule the gate applied to one piece of evidence. */
export interface PolicyBlockEvidenceApplication {
  source: string;
  state: string;
  outcome: 'allow' | 'warn' | 'block';
  rule: string;
  /** Present when the application is about one image rather than the whole node. */
  target?: string;
}

/** One piece of evidence the gate obtained, or failed to. */
export interface PolicyBlockEvidenceRecord {
  source: string;
  state: string;
  target: string;
  collectedAt?: number | null;
  reason?: string;
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
  /**
   * Why the gate lacked the evidence it needed, and which setting turned that
   * into a refusal. Absent on older control payloads and whenever the block was
   * a genuine policy match, which needs no explanation beyond the findings.
   */
  evidence?: {
    outcome: 'allow' | 'warn' | 'block';
    summary: string;
    records?: PolicyBlockEvidenceRecord[];
    applications?: PolicyBlockEvidenceApplication[];
  };
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
  // Anything the gate could not obtain is worth explaining. Applications name
  // the configured rule that produced the outcome; records cover a state no
  // policy governs, such as partial evidence the gate fails closed on by
  // definition. Together they mean the dialog never shows a bare refusal.
  const evidenceLines = buildEvidenceLines(payload?.evidence);
  // A payload can carry both a genuine match and an evidence gap. The gap is
  // still worth naming, but the "not a proven vulnerability" sentence is a claim
  // about the whole block and is false when any image matched on the merits.
  const genuineCount = violations.filter((v) => !v.error).length;
  const hasGenuineViolation = genuineCount > 0;

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
          {hasGenuineViolation
            ? // Counted over the genuine matches only. On a mixed payload the
              // remaining rows are evidence placeholders, which did not trigger
              // anything on the merits.
              `The following ${genuineCount === 1 ? 'image' : `${genuineCount} images`} triggered the block.`
            : 'No image was found to match those conditions. The deploy was stopped because the evidence needed to check them could not be obtained.'}
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
            {hasGenuineViolation
              ? // On a mixed payload this banner is additional context, not the
                // reason for the block, and saying otherwise would be the same
                // false whole-block claim the paragraph above avoids. The
                // recovery hint below still applies: the unscanned image needs
                // resolving either way.
                'Some images could not be scanned as well. Those images are listed above without a finding count, so the block may rest on fewer images than the policy would otherwise have examined. Resolve the issue above and deploy again, or bypass if you accept the risk.'
              : 'The deploy was blocked because the scan did not complete. Resolve the issue above and deploy again, or bypass if you accept the risk.'}
          </p>
        )}
        {evidenceLines.length > 0 && (
          <div className="mt-3 rounded-lg border border-glass-border bg-card/60 px-3 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              Evidence unavailable
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {hasGenuineViolation
                ? 'This deploy was also affected by missing evidence. Alongside the findings above, the evidence below could not be obtained, and your settings say what to do in that case.'
                : 'This deploy was not stopped by a proven vulnerability. It was stopped because the evidence the policy needs could not be obtained, and your settings say what to do in that case.'}
            </p>
            <ul className="mt-2 space-y-1">
              {evidenceLines.map((line) => (
                <li key={line.key} className="text-xs text-muted-foreground break-words">
                  {line.text}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground mt-2">
              Change this on the Security page &rarr; Policies tab, under Evidence availability.
            </p>
          </div>
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
