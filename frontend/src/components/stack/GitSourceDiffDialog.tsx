import { useState, Suspense } from 'react';
import { DiffEditor } from '@/lib/monacoLoader';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { springs } from '@/lib/motion';

export interface PullResult {
  commitSha: string;
  incomingCompose: string;
  incomingEnv: string | null;
  currentCompose: string;
  currentEnv: string | null;
  validation: { ok: boolean; error?: string };
  hasLocalChanges: boolean;
}

interface GitSourceDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  pull: PullResult | null;
  syncEnv: boolean;
  autoDeployDefault: boolean;
  isDarkMode: boolean;
  applying: boolean;
  onApply: (commitSha: string, deploy: boolean) => Promise<void>;
  onDismiss: () => Promise<void>;
}

export function GitSourceDiffDialog({
  open,
  onOpenChange,
  stackName,
  pull,
  syncEnv,
  autoDeployDefault,
  isDarkMode,
  applying,
  onApply,
  onDismiss,
}: GitSourceDiffDialogProps) {
  const [diffTab, setDiffTab] = useState<'compose' | 'env'>('compose');
  const [deployAfter, setDeployAfter] = useState<boolean>(autoDeployDefault);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const envAvailable = syncEnv && pull?.incomingEnv !== null;
  const effectiveTab = envAvailable ? diffTab : 'compose';

  if (!pull) return null;

  const shortSha = pull.commitSha.slice(0, 7);

  const apply = async () => {
    await onApply(pull.commitSha, deployAfter);
  };

  const handleApplyClick = () => {
    if (pull.hasLocalChanges) {
      setConfirmOpen(true);
      return;
    }
    apply();
  };

  const currentValue = effectiveTab === 'compose' ? pull.currentCompose : (pull.currentEnv ?? '');
  const incomingValue = effectiveTab === 'compose' ? pull.incomingCompose : (pull.incomingEnv ?? '');

  return (
    <>
      <Modal size="wide" open={open} onOpenChange={onOpenChange}>
        <ModalHeader
          kicker="GIT · PULL PREVIEW"
          title={stackName}
          description={`Incoming commit ${shortSha}. Review the diff between the current on-disk stack files and the incoming Git commit.`}
        />

        <div className="px-6 pt-4 space-y-3">
          {!pull.validation.ok && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <div>
                <p className="font-medium">Incoming compose failed validation</p>
                <pre className="font-mono text-[11px] whitespace-pre-wrap mt-1">{pull.validation.error}</pre>
              </div>
            </div>
          )}
          {pull.hasLocalChanges && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <div>
                <p className="font-medium">Local edits detected on disk</p>
                <p className="mt-0.5">Applying will overwrite changes that differ from the last applied commit.</p>
              </div>
            </div>
          )}

          {envAvailable && (
            <Tabs value={diffTab} onValueChange={(v) => setDiffTab(v as 'compose' | 'env')}>
              <TabsList>
                <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
                  <TabsHighlightItem value="compose">
                    <TabsTrigger value="compose">Compose</TabsTrigger>
                  </TabsHighlightItem>
                  <TabsHighlightItem value="env">
                    <TabsTrigger value="env">.env</TabsTrigger>
                  </TabsHighlightItem>
                </TabsHighlight>
              </TabsList>
            </Tabs>
          )}
        </div>

        <div className="px-6 pb-4 pt-3">
          <div className="h-[55vh] border border-glass-border rounded-md overflow-hidden">
            <Suspense fallback={<div className="w-full h-full" aria-busy="true" />}>
              <DiffEditor
                height="100%"
                language={effectiveTab === 'compose' ? 'yaml' : 'ini'}
                theme={isDarkMode ? 'vs-dark' : 'vs'}
                original={currentValue}
                modified={incomingValue}
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
          hint={
            <div className="flex items-center gap-2">
              <Checkbox
                id="git-source-deploy-after"
                checked={deployAfter}
                onCheckedChange={(checked) => setDeployAfter(checked === true)}
                disabled={applying || !pull.validation.ok}
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
              onClick={handleApplyClick}
              disabled={applying || !pull.validation.ok}
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

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        kicker="GIT · LOCAL CHANGES"
        title="Overwrite local edits?"
        description="The on-disk stack files differ from the last applied commit. Applying this pull will replace them with the incoming content."
        confirmLabel="Overwrite and apply"
        confirming={applying}
        onConfirm={async () => {
          setConfirmOpen(false);
          await apply();
        }}
      />
    </>
  );
}
