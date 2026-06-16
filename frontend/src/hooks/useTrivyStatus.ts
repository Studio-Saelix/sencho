import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { TrivyStatus, TrivyUpdateCheck } from '@/types/security';

const INITIAL_STATUS: TrivyStatus = {
  available: false,
  version: null,
  source: 'none',
  autoUpdate: false,
  honorSuppressionsOnDeploy: false,
  preDeployScanAdvisory: false,
  busy: false,
};

export interface UseTrivyStatusResult {
  status: TrivyStatus;
  updateCheck: TrivyUpdateCheck | null;
  refresh: () => Promise<void>;
  refreshUpdateCheck: () => Promise<void>;
}

export function useTrivyStatus(): UseTrivyStatusResult {
  const [status, setStatus] = useState<TrivyStatus>(INITIAL_STATUS);
  const [updateCheck, setUpdateCheck] = useState<TrivyUpdateCheck | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch('/security/trivy-status');
      if (!r.ok) return;
      const d = await r.json();
      setStatus({
        available: !!d.available,
        version: typeof d.version === 'string' ? d.version : null,
        source: d.source === 'managed' || d.source === 'host' ? d.source : 'none',
        autoUpdate: !!d.autoUpdate,
        honorSuppressionsOnDeploy: !!d.honorSuppressionsOnDeploy,
        preDeployScanAdvisory: !!d.preDeployScanAdvisory,
        busy: !!d.busy,
      });
    } catch (err) {
      console.error('Failed to fetch Trivy status:', err);
    }
  }, []);

  const refreshUpdateCheck = useCallback(async () => {
    try {
      const r = await apiFetch('/security/trivy-update-check');
      if (!r.ok) {
        setUpdateCheck(null);
        return;
      }
      const d = (await r.json()) as TrivyUpdateCheck;
      setUpdateCheck(d);
    } catch {
      setUpdateCheck(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status.source === 'managed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refreshUpdateCheck();
    } else {
      setUpdateCheck(null);
    }
  }, [status.source, refreshUpdateCheck]);

  return { status, updateCheck, refresh, refreshUpdateCheck };
}
