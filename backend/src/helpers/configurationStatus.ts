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
};

/**
 * Older remotes omit `apprise`. Default the slot so mixed-version hubs do not
 * treat the response as malformed or crash UI consumers.
 */
export function normalizeConfigurationAgents(agents: {
  discord: AgentStatus;
  slack: AgentStatus;
  webhook: AgentStatus;
  apprise?: AgentStatus;
}): ConfigurationAgents {
  return {
    discord: agents.discord,
    slack: agents.slack,
    webhook: agents.webhook,
    apprise: agents.apprise ?? { configured: false, enabled: false },
  };
}
