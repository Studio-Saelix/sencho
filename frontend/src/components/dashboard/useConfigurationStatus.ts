import { useState, useEffect, useCallback, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';

// Trailing-edge debounce window for filtered settings-event refetches,
// matching the precedent in useNextAutoUpdateRun.
const INVALIDATE_DEBOUNCE_MS = 250;

interface AgentStatus {
  configured: boolean;
  enabled: boolean;
}

export interface ConfigurationStatus {
  tier: 'community' | 'paid';
  variant: 'skipper' | 'admiral' | null;
  notifications: {
    agents: { discord: AgentStatus; slack: AgentStatus; webhook: AgentStatus };
    alertRules: number;
    routingRules: { count: number; enabledCount: number; locked: boolean; requiredTier: 'skipper' };
  };
  automation: {
    autoHeal: { total: number; enabled: number };
    autoUpdate: { enabled: number; total: number };
    scheduledTasks: { total: number; enabled: number; locked: boolean; requiredTier: 'admiral' };
    webhooks: { total: number; enabled: number; locked: boolean; requiredTier: 'skipper' };
  };
  security: {
    mfaEnabled: boolean | null;
    ssoEnabled: boolean;
    ssoProvider: string | null;
    scanPolicies: { total: number; enabled: number; locked: boolean; requiredTier: 'skipper' };
  };
  thresholds: {
    cpuLimit: number;
    ramLimit: number;
    diskLimit: number;
    dockerJanitorGb: number;
    globalCrash: boolean;
  };
  backup: {
    provider: 'disabled' | 'sencho' | 'custom';
    autoUpload: boolean;
    locked: boolean;
  };
}

export function useConfigurationStatus() {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const nodeIdRef = useRef(nodeId);
  useEffect(() => { nodeIdRef.current = nodeId; }, [nodeId]);

  const [status, setStatus] = useState<ConfigurationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/dashboard/configuration');
      if (!res.ok) return;
      const data = await res.json() as ConfigurationStatus;
      setStatus(data);
    } catch {
      // Silent; stale data stays visible
    } finally {
      setLoading(false);
    }
  }, []);

  // Configuration data is derived from settings/policy tables (agents,
  // alert rules, auto-heal policies, scheduled tasks, scan policies, cloud
  // backup config). The 60 s poll catches settings drift on its own.
  useEffect(() => {
    setStatus(null);
    setLoading(true);
    const currentNodeId = nodeId;
    const guard = () => { if (nodeIdRef.current === currentNodeId) void fetchStatus(); };
    guard();
    return visibilityInterval(guard, 60_000);
  }, [nodeId, fetchStatus]);

  // Filter `sencho:state-invalidate` so only settings-affecting events
  // refetch the configuration; the high-frequency `scope: 'stack'` and
  // `scope: 'image-updates'` container/image bursts are ignored. Today the
  // only such settings event is `auto-update-settings-changed` (emitted by
  // the stack auto-update toggle). The filter is debounced and the
  // configuration response includes the toggled state, so a user editing
  // the setting sees the row update under a second instead of waiting up
  // to a minute.
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string; scope?: string }>).detail;
      if (detail?.action !== 'auto-update-settings-changed') return;
      if (invalidateTimer) clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        void fetchStatus();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (invalidateTimer) clearTimeout(invalidateTimer);
    };
  }, [fetchStatus]);

  return { status, loading };
}
