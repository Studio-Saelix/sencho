import { Info } from 'lucide-react';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { useNodes } from '@/context/NodeContext';
import { TrivyManager } from './TrivyManager';

/** Scanner install/update/health for the active node. Owns the single
 *  useTrivyStatus instance and feeds the controlled TrivyManager. */
export function ScannerSetupTab() {
  const { status, updateCheck, refresh, refreshUpdateCheck } = useTrivyStatus();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Vulnerability scanning uses Trivy, installed independently on each node. Manage the scanner for the
        active node here.
      </p>
      <TrivyManager
        status={status}
        updateCheck={updateCheck}
        refresh={refresh}
        refreshUpdateCheck={refreshUpdateCheck}
      />
      {isRemote && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-lg border border-card-border bg-muted/30 px-4 py-3"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-sm">
            <div className="font-medium">Scanner is per-node</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Trivy is installed independently on each Sencho instance. Scan policies and CVE suppressions are managed on the control node.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
