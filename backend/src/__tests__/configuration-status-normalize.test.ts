import { describe, it, expect } from 'vitest';
import { normalizeConfigurationAgents, normalizeRemoteConfigurationStatus } from '../helpers/configurationStatus';

describe('normalizeConfigurationAgents', () => {
  it('defaults missing apprise to disabled/unconfigured', () => {
    const normalized = normalizeConfigurationAgents({
      discord: { configured: true, enabled: true },
      slack: { configured: false, enabled: false },
      webhook: { configured: true, enabled: false },
    });
    expect(normalized.apprise).toEqual({ configured: false, enabled: false });
    expect(normalized.discord.enabled).toBe(true);
  });

  it('preserves an explicit apprise slot', () => {
    const normalized = normalizeConfigurationAgents({
      discord: { configured: false, enabled: false },
      slack: { configured: false, enabled: false },
      webhook: { configured: false, enabled: false },
      apprise: { configured: true, enabled: true },
    });
    expect(normalized.apprise).toEqual({ configured: true, enabled: true });
  });
});

describe('normalizeRemoteConfigurationStatus', () => {
  it('passes through stub payloads without notifications.agents', () => {
    const stub = { ssoConfigured: false, alertsConfigured: true };
    expect(normalizeRemoteConfigurationStatus(stub)).toEqual(stub);
  });

  it('fills missing apprise when an agents block is present', () => {
    const raw = {
      notifications: {
        agents: {
          discord: { configured: true, enabled: true },
          slack: { configured: false, enabled: false },
          webhook: { configured: false, enabled: false },
        },
      },
    };
    const normalized = normalizeRemoteConfigurationStatus(raw);
    expect(normalized.notifications.agents).toEqual({
      discord: { configured: true, enabled: true },
      slack: { configured: false, enabled: false },
      webhook: { configured: false, enabled: false },
      apprise: { configured: false, enabled: false },
    });
  });
});
