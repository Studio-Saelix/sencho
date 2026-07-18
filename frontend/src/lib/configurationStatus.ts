/** Wire shape for a single notification agent slot on /dashboard/configuration. */
export interface AgentStatus {
  configured: boolean;
  enabled: boolean;
}

/** Agents block as returned by current hubs (four channels). */
export type ConfigurationAgents = {
  discord: AgentStatus;
  slack: AgentStatus;
  webhook: AgentStatus;
  apprise: AgentStatus;
};

/**
 * Older remotes omit `apprise`. Treat a missing slot as unconfigured/disabled so
 * upgraded hubs do not throw when reading mixed-version fleet/dashboard payloads.
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
