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
  ntfy: AgentStatus;
};

/**
 * Older remotes omit `apprise` or `ntfy`. Treat missing slots as
 * unconfigured/disabled so upgraded hubs do not throw when reading
 * mixed-version fleet/dashboard payloads.
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
