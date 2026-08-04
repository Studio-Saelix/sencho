import { Suspense } from 'react';
import { DiffEditor } from '@/lib/monacoLoader';
import { Modal, ModalHeader, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import type { ComposeDiffActionLabel } from '@/components/resolveComposeDiffActionLabel';

export interface ComposeDiffPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  fileName: string;
  language: 'yaml' | 'ini';
  original: string;
  modified: string;
  actionLabel: ComposeDiffActionLabel;
  confirming: boolean;
  isDarkMode: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ComposeDiffPreviewDialog({
  open,
  onOpenChange,
  stackName,
  fileName,
  language,
  original,
  modified,
  actionLabel,
  confirming,
  isDarkMode,
  onConfirm,
}: ComposeDiffPreviewDialogProps) {
  return (
    <Modal size="wide" open={open} onOpenChange={onOpenChange}>
      <ModalHeader
        kicker={`${stackName} · COMPOSE DIFF`}
        title={fileName}
        description="Review the diff between on-disk content and unsaved editor changes before saving."
      />

      <div className="px-6 pb-4 pt-3">
        <div className="h-[55vh] border border-glass-border rounded-md overflow-hidden">
          <Suspense fallback={<div className="w-full h-full" aria-busy="true" />}>
            <DiffEditor
              height="100%"
              language={language}
              theme={isDarkMode ? 'vs-dark' : 'vs'}
              original={original}
              modified={modified}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontFamily: "'Geist Mono', monospace",
                fontSize: 12,
              }}
            />
          </Suspense>
        </div>
      </div>

      <ModalFooter
        hint="ON DISK → UNSAVED"
        secondary={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            Cancel
          </Button>
        }
        primary={
          <BusyButton
            size="sm"
            pending={confirming}
            onClick={() => onConfirm()}
          >
            {actionLabel}
          </BusyButton>
        }
      />
    </Modal>
  );
}
