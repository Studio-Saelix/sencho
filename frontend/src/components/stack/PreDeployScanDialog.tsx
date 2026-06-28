import {
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { SeverityChip } from '@/components/VulnerabilityScanSheet';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { PreDeployScanImage } from '@/types/security';

interface PreDeployScanDialogProps {
  open: boolean;
  stackName: string;
  images: PreDeployScanImage[];
  onCancel: () => void;
  onDeploy: () => void;
}

/**
 * Advisory pre-deploy review. Shows the latest cached scan for each image in a
 * manual deploy so the operator can review the security posture before
 * proceeding. Unlike PolicyBlockDialog this never blocks: anyone can deploy or
 * cancel, and there is no override gate (blocking is the deploy-block
 * policy). Opened opt-in via the pre-deploy scan advisory setting.
 */
export function PreDeployScanDialog({ open, stackName, images, onCancel, onDeploy }: PreDeployScanDialogProps) {
  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onCancel(); }} size="xl">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · PRE-DEPLOY · SCAN REVIEW`}
        title="Review scan results before deploying"
        description="The latest vulnerability scan for each image in this deploy. Advisory only; it does not block the deploy."
      />
      <ModalBody>
        <div className="border border-glass-border bg-card/60 shadow-card-bevel divide-y divide-glass-border">
          {images.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">No images found for this stack.</div>
          ) : (
            images.map((img) => (
              <div key={img.imageRef} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-sm truncate">{img.imageRef}</div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle tabular-nums">
                    {img.scan
                      ? `${img.scan.criticalCount} critical · ${img.scan.highCount} high · ${img.scan.mediumCount} medium · ${img.scan.lowCount} low · scanned ${formatTimeAgo(img.scan.scannedAt)}`
                      : 'not scanned'}
                  </div>
                </div>
                {img.scan?.highestSeverity ? (
                  <SeverityChip severity={img.scan.highestSeverity} />
                ) : null}
              </div>
            ))
          )}
        </div>
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              onDeploy();
            }}
          >
            Deploy
          </Button>
        }
      />
    </Modal>
  );
}
