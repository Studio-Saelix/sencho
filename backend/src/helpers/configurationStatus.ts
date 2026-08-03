/** Agent slot on dashboard/fleet configuration responses. */
export interface AgentStatus {
  configured: boolean;
  enabled: boolean;
}

export type ConfigurationAgents = {
  discord: AgentStatus;
  slack: AgentStatus;
  webhook: AgentStatus;
  apprise: AgentStatus;
  ntfy: AgentStatus;
};

/**
 * Older remotes omit `apprise` or `ntfy`. Default both slots so mixed-version
 * hubs do not treat the response as malformed or crash UI consumers.
 */
export function normalizeConfigurationAgents(agents: {
  discord: AgentStatus;
  slack: AgentStatus;
  webhook: AgentStatus;
  apprise?: AgentStatus;
  ntfy?: AgentStatus;
}): ConfigurationAgents {
  return {
    discord: agents.discord,
    slack: agents.slack,
    webhook: agents.webhook,
    apprise: agents.apprise ?? { configured: false, enabled: false },
    ntfy: agents.ntfy ?? { configured: false, enabled: false },
  };
}

/**
 * Normalize a remote `/dashboard/configuration` body when it carries an agents
 * block. Stub or partial JSON without `notifications.agents` is returned as-is
 * so a successful fetch still marks the node online.
 */
export function normalizeRemoteConfigurationStatus<T extends object>(raw: T): T {
  const notifications = (raw as { notifications?: { agents?: Parameters<typeof normalizeConfigurationAgents>[0] } }).notifications;
  if (!notifications?.agents) return raw;
  return {
    ...raw,
    notifications: {
      ...notifications,
      agents: normalizeConfigurationAgents(notifications.agents),
    },
  };
}
