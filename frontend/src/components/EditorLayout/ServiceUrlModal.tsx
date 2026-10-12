import { useState } from 'react';
import { BusyButton } from '@/components/ui/busy-button';
import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { serviceUrlFromLabelValue } from '@/lib/serviceUrlLabel';

interface ServiceUrlModalProps {
  open: boolean;
  serviceName: string;
  initialUrl: string;
  dirty: boolean;
  saving: boolean;
  verifyMessage: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (url: string | null) => void;
  onRetryVerify: () => void;
}

export function ServiceUrlModal({
  open,
  serviceName,
  initialUrl,
  dirty,
  saving,
  verifyMessage,
  onOpenChange,
  onSave,
  onRetryVerify,
}: ServiceUrlModalProps) {
  const [value, setValue] = useState(initialUrl);

  const trimmed = value.trim();
  const parsed = trimmed ? serviceUrlFromLabelValue(trimmed) : null;
  const invalid = trimmed.length > 0 && parsed === null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <ModalHeader
        kicker="Service URL"
        title={serviceName}
        description="This address opens when the published port is clicked. Leave it empty to use the generated host and port."
      />
      <ModalBody>
        <label className="block space-y-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">URL</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://app.example.com"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-card-border bg-background px-3 py-2 font-mono text-sm text-foreground max-md:min-h-11"
          />
        </label>
        <p className="text-xs text-stat-subtitle">
          The URL is stored in the compose file and is visible to anyone who can read this stack. Do not put a password in it.
        </p>
        {dirty ? (
          <p className="text-xs text-stat-subtitle">Saving also writes the compose edits already in the editor.</p>
        ) : null}
        {invalid ? (
          <p className="text-xs text-destructive">Use an http or https address with no username or password.</p>
        ) : null}
        {verifyMessage ? (
          <div className="space-y-2">
            <p className="text-xs text-destructive">{verifyMessage}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetryVerify} className="max-md:min-h-11">
              Retry
            </Button>
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter
        primary={(
          <BusyButton
            type="button"
            pending={saving}
            disabled={invalid || saving}
            onClick={() => onSave(parsed)}
          >
            Save URL
          </BusyButton>
        )}
        secondary={(
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
        )}
      />
    </Modal>
  );
}
