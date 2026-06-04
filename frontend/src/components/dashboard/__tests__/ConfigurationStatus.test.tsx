import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const useConfigurationStatusMock = vi.fn();
vi.mock('../useConfigurationStatus', () => ({
  useConfigurationStatus: () => useConfigurationStatusMock(),
}));

import { ConfigurationStatus } from '../ConfigurationStatus';
import type { ConfigurationStatus as ConfigurationStatusPayload } from '../useConfigurationStatus';

function makePayload(overrides: Partial<ConfigurationStatusPayload> = {}): ConfigurationStatusPayload {
  return {
    tier: 'community',
    notifications: {
      agents: {
        discord: { configured: false, enabled: false },
        slack: { configured: false, enabled: false },
        webhook: { configured: false, enabled: false },
      },
      alertRules: 0,
      routingRules: { count: 0, enabledCount: 0, locked: true },
    },
    automation: {
      autoHeal: { total: 0, enabled: 0 },
      autoUpdate: { enabled: 0, total: 0 },
      scheduledTasks: { total: 0, enabled: 0, locked: true },
      webhooks: { total: 0, enabled: 0, locked: true },
    },
    security: {
      mfaEnabled: null,
      ssoEnabled: false,
      ssoProvider: null,
      scanPolicies: { total: 0, enabled: 0, locked: true },
    },
    thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false },
    backup: { provider: 'disabled', autoUpload: false, locked: false },
    ...overrides,
  };
}

beforeEach(() => {
  useConfigurationStatusMock.mockReset();
});

describe('ConfigurationStatus row visibility', () => {
  it('renders a skeleton while loading', () => {
    useConfigurationStatusMock.mockReturnValue({ status: null, loading: true });
    render(<ConfigurationStatus />);
    expect(screen.getByText('Configuration Status')).toBeDefined();
    // Skeleton renders placeholder rows; assert the load-error message is NOT shown.
    expect(screen.queryByText(/Unable to load configuration/i)).toBeNull();
  });

  it('renders an error state when the payload is null and not loading', () => {
    useConfigurationStatusMock.mockReturnValue({ status: null, loading: false });
    render(<ConfigurationStatus />);
    expect(screen.getByText(/Unable to load configuration/i)).toBeDefined();
  });

  it('always shows the Automation section and its free rows, hiding only the per-row locked entries', () => {
    useConfigurationStatusMock.mockReturnValue({ status: makePayload(), loading: false });
    render(<ConfigurationStatus />);

    // Automation moved to free: the section and its auto-heal / auto-update
    // rows render for every tier.
    expect(screen.getByText('Automation')).toBeDefined();
    expect(screen.getByText('Auto-heal policies')).toBeDefined();
    expect(screen.getByText('Auto-update schedules')).toBeDefined();
    // Rows whose payload reports locked stay hidden.
    expect(screen.queryByText('Notification routing')).toBeNull();
    expect(screen.queryByText('Webhooks')).toBeNull();
    expect(screen.queryByText('Scheduled tasks')).toBeNull();
    expect(screen.queryByText('Vulnerability scanning')).toBeNull();
    // Cloud Backup row is universal (Custom S3 is open to every tier).
    expect(screen.getByText('Cloud Backup')).toBeDefined();
  });

  it('shows every row when the payload reports nothing locked', () => {
    useConfigurationStatusMock.mockReturnValue({
      status: makePayload({
        tier: 'paid',
        notifications: {
          agents: {
            discord: { configured: false, enabled: false },
            slack: { configured: false, enabled: false },
            webhook: { configured: false, enabled: false },
          },
          alertRules: 2,
          routingRules: { count: 1, enabledCount: 1, locked: false },
        },
        automation: {
          autoHeal: { total: 3, enabled: 2 },
          autoUpdate: { enabled: 4, total: 5 },
          scheduledTasks: { total: 1, enabled: 1, locked: false },
          webhooks: { total: 1, enabled: 1, locked: false },
        },
        security: {
          mfaEnabled: true,
          ssoEnabled: true,
          ssoProvider: 'oidc_google',
          scanPolicies: { total: 2, enabled: 2, locked: false },
        },
      }),
      loading: false,
    });
    render(<ConfigurationStatus />);

    expect(screen.getByText('Automation')).toBeDefined();
    expect(screen.getByText('Auto-heal policies')).toBeDefined();
    expect(screen.getByText('Auto-update schedules')).toBeDefined();
    expect(screen.getByText('Notification routing')).toBeDefined();
    expect(screen.getByText('Webhooks')).toBeDefined();
    expect(screen.getByText('Scheduled tasks')).toBeDefined();
    expect(screen.getByText('Vulnerability scanning')).toBeDefined();
    expect(screen.getByText('Cloud Backup')).toBeDefined();
    // SSO label maps the provider to a friendly name.
    expect(screen.getByText('Google')).toBeDefined();
  });
});
