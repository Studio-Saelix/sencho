import { useState, useEffect, useCallback, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';
import { normalizeConfigurationAgents, type AgentStatus } from '@/lib/configurationStatus';
import { MUTE_RULES_CHANGED_EVENT } from '@/lib/muteRules';

// Trailing-edge debounce window for filtered settings-event refetches,
// matching the precedent in useNextAutoUpdateRun.
const INVALIDATE_DEBOUNCE_MS = 250;

export interface ConfigurationStatus {
  tier: 'community' | 'paid';
  notifications: {
    agents: { discord: AgentStatus; slack: AgentStatus; webhook: AgentStatus; apprise: AgentStatus; ntfy: AgentStatus };
    alertRules: number;
    routingRules: { count: number; enabledCount: number; locked: boolean };
    suppressionRules: { total: number; enabledCount: number };
  };
  automation: {
    autoHeal: { total: number; enabled: number };
    autoUpdate: { enabled: number; total: number };
    scheduledTasks: { total: number; enabled: number; locked: boolean };
    webhooks: { total: number; enabled: number; locked: boolean };
  };
  security: {
    mfaEnabled: boolean | null;
    ssoEnabled: boolean;
    ssoProvider: string | null;
    trivyInstalled: boolean;
    scanPolicies: { total: number; enabled: number; locked: boolean };
  };
  thresholds: {
    cpuLimit: number;
    ramLimit: number;
    diskLimit: number;
    dockerJanitorGb: number;
    globalCrash: boolean;
    hostAlertsEnabled: boolean;
  };
  backup: {
    provider: 'disabled' | 'sencho' | 'custom';
    autoUpload: boolean;
    locked: boolean;
  };
}

/** Wire payload may omit `apprise` from older remotes. */
type WireConfigurationStatus = Omit<ConfigurationStatus, 'notifications'> & {
  notifications: Omit<ConfigurationStatus['notifications'], 'agents'> & {
    agents: {
      discord: AgentStatus;
      slack: AgentStatus;
      webhook: AgentStatus;
      apprise?: AgentStatus;
      ntfy?: AgentStatus;
    };
  };
};

function normalizeConfigurationStatus(raw: WireConfigurationStatus): ConfigurationStatus {
  return {
    ...raw,
    notifications: {
      ...raw.notifications,
      agents: normalizeConfigurationAgents(raw.notifications.agents),
    },
  };
}

export function useConfigurationStatus() {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const nodeIdRef = useRef(nodeId);
  useEffect(() => { nodeIdRef.current = nodeId; }, [nodeId]);

  const [status, setStatus] = useState<ConfigurationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Set when the latest refresh failed. The last good payload stays on screen,
  // and the card marks it stale instead of passing it off as current.
  const [stale, setStale] = useState(false);
  const requestSeqRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    // Poll, invalidation, and reconnect fetches can overlap, and a switch can
    // land mid-request. Only the newest request for the current node may write.
    const requestedFor = nodeIdRef.current;
    const seq = ++requestSeqRef.current;
    const current = () => nodeIdRef.current === requestedFor && seq === requestSeqRef.current;
    try {
      const res = await apiFetch('/dashboard/configuration');
      if (!current()) return;
      if (!res.ok) {
        console.error('[dashboard] configuration status fetch failed:', res.status);
        setStale(true);
        return;
      }
      const data = await res.json() as WireConfigurationStatus;
      if (!current()) return;
      setStatus(normalizeConfigurationStatus(data));
      setStale(false);
    } catch (err) {
      if (!current()) return;
      console.error('[dashboard] configuration status fetch error:', err);
      setStale(true);
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  // Configuration data is derived from settings/policy tables (agents,
  // alert rules, auto-heal policies, scheduled tasks, scan policies, cloud
  // backup config). Settings are edited in their own view, so returning to Home
  // remounts and refetches; the signals below cover edits made while Home stays
  // mounted, and the 60 s poll is the safety net for edits made elsewhere.
  useEffect(() => {
    setStatus(null);
    setStale(false);
    setLoading(true);
    const currentNodeId = nodeId;
    const guard = () => { if (nodeIdRef.current === currentNodeId) void fetchStatus(); };
    guard();
    return visibilityInterval(guard, 60_000);
  }, [nodeId, fetchStatus]);

  // Refetch the configuration card when a scheduled-tasks mutation fires
  // an invalidate. High-frequency `scope: 'stack'` and `scope: 'image-updates'`
  // events are ignored; they don't change any tile on this card. Debounced
  // so a burst of edits coalesces into a single fetch.
  useEffect(() => {
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'scheduled-tasks') return;
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

  // Mute rules can be created from the notification panel while Home stays
  // mounted underneath it.
  useEffect(() => {
    const onMuteRulesChanged = () => { void fetchStatus(); };
    window.addEventListener(MUTE_RULES_CHANGED_EVENT, onMuteRulesChanged);
    return () => window.removeEventListener(MUTE_RULES_CHANGED_EVENT, onMuteRulesChanged);
  }, [fetchStatus]);

  // Socket reconnect: refetch on the connected edge only, since configuration
  // may have moved while the stream was down. This fires on the first connect
  // as well as a reconnect; a disconnect is not a fetch signal.
  useEffect(() => {
    const onConnection = (e: Event) => {
      const detail = (e as CustomEvent<{ connected?: boolean }>).detail;
      if (detail?.connected === true) void fetchStatus();
    };
    window.addEventListener('sencho:notifications-connection', onConnection);
    return () => window.removeEventListener('sencho:notifications-connection', onConnection);
  }, [fetchStatus]);

  return { status, loading, stale };
}
