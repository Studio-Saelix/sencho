import { useState } from 'react';
import { AlertTriangle, GitBranch, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';

export type GitChangePlanOp =
  | 'add'
  | 'modify'
  | 'delete'
  | 'rename'
  | 'unchanged'
  | 'local-modified'
  | 'local-missing'
  | 'type-changed'
  | 'unmanaged-collision'
  | 'invocation';

export interface PublicGitChangePlanOperation {
  path: string | null;
  op: GitChangePlanOp;
  role: string;
  fromPath?: string | null;
}

export interface GitChangePlanCounts {
  add: number;
  modify: number;
  delete: number;
  rename: number;
  unchanged: number;
  localModified: number;
  localMissing: number;
  typeChanged: number;
  unmanagedCollision: number;
  invocation: number;
}

export interface PublicGitChangePlan {
  blocked: boolean;
  counts: GitChangePlanCounts;
  operations: PublicGitChangePlanOperation[];
  invocation: {
    candidateChanged: boolean;
    liveDiverged: boolean;
  };
}

export interface PublicPendingPlan {
  fingerprint: string;
  blocked: boolean;
  counts: GitChangePlanCounts;
  operations: PublicGitChangePlanOperation[];
}

export interface PullResult {
  commitSha: string;
  validation: { ok: boolean; error?: string };
  refusals?: Array<{ sourcePath: string | null; kind: string; reason: string; actionable: boolean }>;
  warnings?: string[];
  plan: PublicGitChangePlan | null;
  planFingerprint: string | null;
}

interface GitSourceDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  pull: PullResult | null;
  autoDeployDefault: boolean;
  applying: boolean;
  onApply: (commitSha: string, deploy: boolean, planFingerprint: string) => Promise<void>;
  onDismiss: () => Promise<void>;
}

const OP_LABEL: Record<GitChangePlanOp, string> = {
  add: 'Add',
  modify: 'Modify',
  delete: 'Remove',
  rename: 'Rename',
  unchanged: 'Unchanged',
  'local-modified': 'Locally modified',
  'local-missing': 'Missing on disk',
  'type-changed': 'Type changed',
  'unmanaged-collision': 'Unmanaged file in the way',
  invocation: 'Compose invocation',
};

const BLOCKING_OPS = new Set<GitChangePlanOp>([
  'local-modified',
  'local-missing',
  'type-changed',
  'unmanaged-collision',
]);

export function GitSourceDiffDialog({
  open,
  onOpenChange,
  stackName,
  pull,
  autoDeployDefault,
  applying,
  onApply,
  onDismiss,
}: GitSourceDiffDialogProps) {
  const [deployAfter, setDeployAfter] = useState<boolean>(autoDeployDefault);

  if (!pull) return null;

  const shortSha = pull.commitSha.slice(0, 7);
  const missingPlan = !pull.plan || !pull.planFingerprint;
  const blocked = missingPlan || pull.plan?.blocked === true || !pull.validation.ok;
  const ops = pull.plan?.operations ?? [];
  const unchanged = pull.plan?.counts.unchanged ?? 0;

  const apply = async () => {
    if (!pull.planFingerprint || blocked) return;
    await onApply(pull.commitSha, deployAfter, pull.planFingerprint);
  };

  return (
    <Modal size="wide" open={open} onOpenChange={onOpenChange} mobileFullScreen>
      <ModalHeader
        kicker="GIT · CHANGE PLAN"
        title={stackName}
        description={`Incoming commit ${shortSha}. Review classified file operations before applying. Local conflicts block apply; unmanaged files are left untouched.`}
      />

      <div className="px-6 pt-4 space-y-3 max-md:px-4">
        {!pull.validation.ok && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <div>
              <p className="font-medium">Incoming compose failed validation</p>
              <pre className="font-mono text-[11px] whitespace-pre-wrap mt-1">{pull.validation.error}</pre>
            </div>
          </div>
        )}
        {missingPlan && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <div>
              <p className="font-medium">Change plan unavailable</p>
              <p className="mt-0.5">This node did not return a classified plan. Pull again after updating the remote instance.</p>
            </div>
          </div>
        )}
        {pull.plan?.blocked && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <div>
              <p className="font-medium">Local conflicts block apply</p>
              <p className="mt-0.5">Resolve locally modified, missing, or colliding files, then pull again. Sencho will not overwrite them.</p>
            </div>
          </div>
        )}
        {pull.plan?.invocation.liveDiverged && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <p className="font-medium">Live compose invocation no longer matches the last applied generation.</p>
          </div>
        )}
      </div>

      <div className="px-6 pb-4 pt-3 max-md:px-4">
        <ScrollArea className="h-[45vh] max-md:h-[40vh] border border-glass-border rounded-md">
          <ul className="divide-y divide-glass-border text-sm">
            {ops.map((op, i) => (
              <li
                key={`${op.op}-${op.path ?? 'redacted'}-${i}`}
                className="flex items-start gap-3 px-3 py-2"
                data-testid="git-plan-op"
                data-op={op.op}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 mt-0.5 text-stat-subtitle" strokeWidth={1.5} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {OP_LABEL[op.op]}
                    {BLOCKING_OPS.has(op.op) ? ' (blocks apply)' : ''}
                  </p>
                  <p className="font-mono text-xs text-stat-subtitle truncate">
                    {op.op === 'rename' && op.fromPath
                      ? `${op.fromPath} → ${op.path ?? 'secret-bearing path'}`
                      : op.path ?? 'secret-bearing managed path'}
                  </p>
                </div>
              </li>
            ))}
            {unchanged > 0 && (
              <li className="px-3 py-2 text-xs text-stat-subtitle">
                {unchanged} unchanged file{unchanged === 1 ? '' : 's'}
              </li>
            )}
            {ops.length === 0 && unchanged === 0 && !missingPlan && (
              <li className="px-3 py-2 text-xs text-stat-subtitle">No file operations in this plan.</li>
            )}
          </ul>
        </ScrollArea>
      </div>

      <ModalFooter
        hint={
          <div className="flex items-center gap-2">
            <Checkbox
              id="git-source-deploy-after"
              checked={deployAfter}
              onCheckedChange={(checked) => setDeployAfter(checked === true)}
              disabled={applying || blocked}
            />
            <Label
              htmlFor="git-source-deploy-after"
              className="text-xs normal-case tracking-normal cursor-pointer"
            >
              Deploy after apply
            </Label>
          </div>
        }
        secondary={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDismiss()}
            disabled={applying}
          >
            Dismiss
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={apply}
            disabled={applying || blocked}
          >
            {applying ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />
                Applying...
              </>
            ) : (
              'Apply'
            )}
          </Button>
        }
      />
    </Modal>
  );
}
