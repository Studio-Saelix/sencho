import { useState, useEffect, useCallback, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';

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
  // backup config). It does not depend on live container state, so the
  // dashboard does not subscribe to `sencho:state-invalidate`. The 60 s
  // poll catches settings drift; a settings page that mutates the response
  // is the rare event where a one-minute lag is acceptable.
  useEffect(() => {
    setStatus(null);
    setLoading(true);
    const currentNodeId = nodeId;
    const guard = () => { if (nodeIdRef.current === currentNodeId) void fetchStatus(); };
    guard();
    return visibilityInterval(guard, 60_000);
  }, [nodeId, fetchStatus]);

  return { status, loading };
}
