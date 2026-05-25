import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const useConfigurationStatusMock = vi.fn();
vi.mock('../useConfigurationStatus', () => ({
  useConfigurationStatus: () => useConfigurationStatusMock(),
}));

const useLicenseMock = vi.fn();
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => useLicenseMock(),
}));

import { ConfigurationStatus } from '../ConfigurationStatus';
import type { ConfigurationStatus as ConfigurationStatusPayload } from '../useConfigurationStatus';

function makePayload(overrides: Partial<ConfigurationStatusPayload> = {}): ConfigurationStatusPayload {
  return {
    tier: 'community',
    variant: null,
    notifications: {
      agents: {
        discord: { configured: false, enabled: false },
        slack: { configured: false, enabled: false },
        webhook: { configured: false, enabled: false },
      },
      alertRules: 0,
      routingRules: { count: 0, enabledCount: 0, locked: true, requiredTier: 'skipper' },
    },
    automation: {
      autoHeal: { total: 0, enabled: 0 },
      autoUpdate: { enabled: 0, total: 0 },
      scheduledTasks: { total: 0, enabled: 0, locked: true, requiredTier: 'admiral' },
      webhooks: { total: 0, enabled: 0, locked: true, requiredTier: 'skipper' },
    },
    security: {
      mfaEnabled: null,
      ssoEnabled: false,
      ssoProvider: null,
      scanPolicies: { total: 0, enabled: 0, locked: true, requiredTier: 'skipper' },
    },
    thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false },
    backup: { provider: 'disabled', autoUpload: false, locked: false, requiredTier: 'admiral' },
    ...overrides,
  };
}

beforeEach(() => {
  useConfigurationStatusMock.mockReset();
  useLicenseMock.mockReset();
});

describe('ConfigurationStatus tier parity', () => {
  it('renders a skeleton while loading', () => {
    useConfigurationStatusMock.mockReturnValue({ status: null, loading: true });
    useLicenseMock.mockReturnValue({ isPaid: false });
    render(<ConfigurationStatus />);
    expect(screen.getByText('Configuration Status')).toBeDefined();
    // Skeleton renders 8 placeholder rows; assert the load-error message
    // is NOT shown.
    expect(screen.queryByText(/Unable to load configuration/i)).toBeNull();
  });

  it('renders an error state when the payload is null and not loading', () => {
    useConfigurationStatusMock.mockReturnValue({ status: null, loading: false });
    useLicenseMock.mockReturnValue({ isPaid: false });
    render(<ConfigurationStatus />);
    expect(screen.getByText(/Unable to load configuration/i)).toBeDefined();
  });

  it('hides the Automation section, routing rules, vulnerability scanning, and webhooks for Community', () => {
    useConfigurationStatusMock.mockReturnValue({ status: makePayload(), loading: false });
    useLicenseMock.mockReturnValue({ isPaid: false });
    render(<ConfigurationStatus />);

    // Notifications section header always renders.
    expect(screen.getByText('Notifications')).toBeDefined();
    // Locked rows should be absent for Community.
    expect(screen.queryByText('Notification routing')).toBeNull();
    expect(screen.queryByText('Automation')).toBeNull();
    expect(screen.queryByText('Auto-heal policies')).toBeNull();
    expect(screen.queryByText('Auto-update stacks')).toBeNull();
    expect(screen.queryByText('Webhooks')).toBeNull();
    expect(screen.queryByText('Scheduled tasks')).toBeNull();
    expect(screen.queryByText('Vulnerability scanning')).toBeNull();
    // Cloud Backup row is universal (Custom S3 is open to every tier).
    expect(screen.getByText('Cloud Backup')).toBeDefined();
  });

  it('shows Automation rows and Webhooks for Skipper but keeps Scheduled tasks hidden', () => {
    useConfigurationStatusMock.mockReturnValue({
      status: makePayload({
        tier: 'paid',
        variant: 'skipper',
        notifications: {
          agents: {
            discord: { configured: false, enabled: false },
            slack: { configured: false, enabled: false },
            webhook: { configured: false, enabled: false },
          },
          alertRules: 2,
          routingRules: { count: 1, enabledCount: 1, locked: false, requiredTier: 'skipper' },
        },
        automation: {
          autoHeal: { total: 3, enabled: 2 },
          autoUpdate: { enabled: 4, total: 5 },
          scheduledTasks: { total: 0, enabled: 0, locked: true, requiredTier: 'admiral' },
          webhooks: { total: 1, enabled: 1, locked: false, requiredTier: 'skipper' },
        },
        security: {
          mfaEnabled: true,
          ssoEnabled: false,
          ssoProvider: null,
          scanPolicies: { total: 2, enabled: 2, locked: false, requiredTier: 'skipper' },
        },
      }),
      loading: false,
    });
    useLicenseMock.mockReturnValue({ isPaid: true });
    render(<ConfigurationStatus />);

    expect(screen.getByText('Automation')).toBeDefined();
    expect(screen.getByText('Auto-heal policies')).toBeDefined();
    expect(screen.getByText('Auto-update stacks')).toBeDefined();
    expect(screen.getByText('Webhooks')).toBeDefined();
    expect(screen.getByText('Notification routing')).toBeDefined();
    expect(screen.getByText('Vulnerability scanning')).toBeDefined();
    // Scheduled tasks is Admiral-only; the response.locked flag controls
    // visibility independently of the outer isPaid block.
    expect(screen.queryByText('Scheduled tasks')).toBeNull();
  });

  it('shows every gated row for Admiral', () => {
    useConfigurationStatusMock.mockReturnValue({
      status: makePayload({
        tier: 'paid',
        variant: 'admiral',
        notifications: {
          agents: {
            discord: { configured: false, enabled: false },
            slack: { configured: false, enabled: false },
            webhook: { configured: false, enabled: false },
          },
          alertRules: 0,
          routingRules: { count: 0, enabledCount: 0, locked: false, requiredTier: 'skipper' },
        },
        automation: {
          autoHeal: { total: 0, enabled: 0 },
          autoUpdate: { enabled: 0, total: 0 },
          scheduledTasks: { total: 1, enabled: 1, locked: false, requiredTier: 'admiral' },
          webhooks: { total: 0, enabled: 0, locked: false, requiredTier: 'skipper' },
        },
        security: {
          mfaEnabled: true,
          ssoEnabled: true,
          ssoProvider: 'oidc_google',
          scanPolicies: { total: 0, enabled: 0, locked: false, requiredTier: 'skipper' },
        },
      }),
      loading: false,
    });
    useLicenseMock.mockReturnValue({ isPaid: true });
    render(<ConfigurationStatus />);

    expect(screen.getByText('Notification routing')).toBeDefined();
    expect(screen.getByText('Webhooks')).toBeDefined();
    expect(screen.getByText('Scheduled tasks')).toBeDefined();
    expect(screen.getByText('Vulnerability scanning')).toBeDefined();
    expect(screen.getByText('Cloud Backup')).toBeDefined();
    // SSO label maps the provider to a friendly name.
    expect(screen.getByText('Google')).toBeDefined();
  });
});
