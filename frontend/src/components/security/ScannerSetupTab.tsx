import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { TrivyManager } from './TrivyManager';

/** Scanner install/update/health for the active node. Owns the single
 *  useTrivyStatus instance and feeds the controlled TrivyManager. */
export function ScannerSetupTab() {
  const { status, updateCheck, refresh, refreshUpdateCheck } = useTrivyStatus();
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
    </div>
  );
}
