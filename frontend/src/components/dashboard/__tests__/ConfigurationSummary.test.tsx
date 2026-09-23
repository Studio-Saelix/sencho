import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useConfigurationStatusMock = vi.fn();
vi.mock('../useConfigurationStatus', () => ({
  useConfigurationStatus: () => useConfigurationStatusMock(),
}));

import { ConfigurationSummary, type ConfigNavigation } from '../ConfigurationSummary';
import type { ConfigurationStatus as ConfigurationStatusPayload } from '../useConfigurationStatus';

function makePayload(overrides: Partial<ConfigurationStatusPayload> = {}): ConfigurationStatusPayload {
  return {
    tier: 'community',
    notifications: {
      agents: {
        discord: { configured: false, enabled: false },
        slack: { configured: false, enabled: false },
        webhook: { configured: false, enabled: false },
        apprise: { configured: false, enabled: false },
        ntfy: { configured: false, enabled: false },
      },
      alertRules: 0,
      routingRules: { count: 0, enabledCount: 0, locked: true },
      suppressionRules: { total: 0, enabledCount: 0 },
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
      trivyInstalled: false,
      scanPolicies: { total: 0, enabled: 0, locked: false },
    },
    thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false, hostAlertsEnabled: true },
    backup: { provider: 'disabled', autoUpload: false, locked: false },
    ...overrides,
  };
}

/**
 * Nothing locked and most settings on. Channels, crash detection, and backups
 * stay off on purpose: Notifications then reads 3/4 and Recovery 1/3, so an
 * implementation that counts a row as set up without looking at its value
 * cannot pass.
 */
function makeFullPayload(overrides: Partial<ConfigurationStatusPayload> = {}): ConfigurationStatusPayload {
  return makePayload({
    tier: 'paid',
    notifications: {
      agents: makePayload().notifications.agents,
      alertRules: 2,
      routingRules: { count: 1, enabledCount: 1, locked: false },
      suppressionRules: { total: 2, enabledCount: 1 },
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
      trivyInstalled: true,
      scanPolicies: { total: 2, enabled: 2, locked: false },
    },
    ...overrides,
  });
}

function makeNavigation(canOpen: ConfigNavigation['canOpen'] = () => true): ConfigNavigation {
  return { open: vi.fn(), canOpen };
}

function renderWith(payload: ConfigurationStatusPayload | null, loading = false, navigation = makeNavigation()) {
  useConfigurationStatusMock.mockReturnValue({ status: payload, loading });
  const view = render(<ConfigurationSummary navigation={navigation} nodeName="edge-1" />);
  return { ...view, navigation };
}

const domainRow = (id: string) => screen.getByTestId(`config-domain-${id}`);
const domainToggle = (id: string) => within(domainRow(id)).getByRole('button');

/** The expanded item row for a setting, located by its label cell. */
function itemRow(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'td span' }).closest('tr')!;
}

function expand(...ids: string[]) {
  for (const id of ids) fireEvent.click(domainRow(id));
}

beforeEach(() => {
  useConfigurationStatusMock.mockReset();
});

describe('ConfigurationSummary loading and error states', () => {
  it('renders a skeleton and no table while loading', () => {
    renderWith(null, true);
    expect(screen.getByText('Configuration summary')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders an error state when the payload is null and not loading', () => {
    renderWith(null);
    expect(screen.getByText('Unable to load configuration.')).toBeInTheDocument();
  });
});

describe('ConfigurationSummary compact default', () => {
  it('shows one summary row per domain and no individual settings', () => {
    renderWith(makeFullPayload());

    for (const id of ['notifications', 'automation', 'security', 'recovery']) {
      expect(domainToggle(id)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByText('Channels', { selector: 'td span' })).not.toBeInTheDocument();
    expect(within(domainRow('notifications')).getByText('no channels · 2 alert rules · 1 route · 1 mute rule')).toBeInTheDocument();
    expect(within(domainRow('security')).getByText('MFA on · SSO Google · Trivy installed · 2 scan policies')).toBeInTheDocument();
  });

  it('reports the overall and per-domain set-up counts', () => {
    renderWith(makeFullPayload());

    // 15 settings, 3 of them off: channels, crash detection, and backups.
    expect(screen.getByText('12 of 15 set up · edge-1')).toBeInTheDocument();
    expect(within(domainRow('notifications')).getByText('3/4')).toBeInTheDocument();
    expect(within(domainRow('recovery')).getByText('1/3')).toBeInTheDocument();
  });

  it('expands and collapses one domain from the keyboard', async () => {
    const user = userEvent.setup();
    renderWith(makeFullPayload());

    domainToggle('automation').focus();
    await user.keyboard('{Enter}');
    expect(domainToggle('automation')).toHaveAttribute('aria-expanded', 'true');
    expect(itemRow('Webhooks')).toBeInTheDocument();
    expect(screen.queryByText('Channels', { selector: 'td span' })).not.toBeInTheDocument();

    await user.keyboard(' ');
    expect(screen.queryByText('Webhooks', { selector: 'td span' })).not.toBeInTheDocument();
  });
});

describe('ConfigurationSummary scope classification', () => {
  it('labels every setting with the scope it applies to', () => {
    renderWith(makeFullPayload());
    expand('notifications', 'automation', 'security', 'recovery');

    const scopeOf = (label: string) => within(itemRow(label)).getAllByRole('cell')[2].textContent;
    expect(scopeOf('Channels')).toBe('Node');
    expect(scopeOf('Alert rules')).toBe('Node');
    expect(scopeOf('Routing')).toBe('Instance');
    expect(scopeOf('Auto-heal policies')).toBe('Node');
    expect(scopeOf('Scheduled tasks')).toBe('Instance');
    expect(scopeOf('MFA')).toBe('Account');
    expect(scopeOf('SSO')).toBe('Instance');
    expect(scopeOf('Trivy')).toBe('Node');
    expect(scopeOf('Host thresholds')).toBe('Node');
    expect(scopeOf('Crash detection')).toBe('Node');
    expect(scopeOf('Backups')).toBe('Instance');
  });

  it('summarizes the scopes a domain spans on its collapsed row', () => {
    renderWith(makeFullPayload());
    expect(within(domainRow('security')).getByText('Node · Account · Instance')).toBeInTheDocument();
  });

  it('explains what each scope means', () => {
    renderWith(makeFullPayload());
    expect(screen.getByText(/Node settings follow the active node\./)).toBeInTheDocument();
  });
});

describe('ConfigurationSummary locked rows', () => {
  it('never renders or counts a locked row', () => {
    // makePayload locks routing, scheduled tasks, and webhooks.
    renderWith(makePayload());
    expand('notifications', 'automation');

    expect(screen.queryByText('Routing', { selector: 'td span' })).not.toBeInTheDocument();
    expect(screen.queryByText('Webhooks', { selector: 'td span' })).not.toBeInTheDocument();
    expect(within(domainRow('automation')).getByText('0/2')).toBeInTheDocument();
    expect(screen.getByText('1 of 12 set up · edge-1')).toBeInTheDocument();
  });
});

describe('ConfigurationSummary set-up semantics', () => {
  it('does not count a configured-but-disabled policy as set up', () => {
    renderWith(makeFullPayload({
      automation: {
        autoHeal: { total: 2, enabled: 0 },
        autoUpdate: { enabled: 0, total: 1 },
        scheduledTasks: { total: 1, enabled: 1, locked: false },
        webhooks: { total: 1, enabled: 1, locked: false },
      },
    }));
    expect(within(domainRow('automation')).getByText('2/4')).toBeInTheDocument();
    expand('automation');
    expect(within(itemRow('Auto-heal policies')).getByLabelText('Not set up')).toBeInTheDocument();
    expect(within(itemRow('Auto-heal policies')).getByText('0 / 2 active')).toBeInTheDocument();
  });

  it('renders threshold values when host alerts are on and Off when they are not', () => {
    const { unmount } = renderWith(makeFullPayload());
    expand('recovery');
    expect(within(itemRow('Host thresholds')).getByText('CPU 90% · RAM 90% · Disk 90%')).toBeInTheDocument();
    unmount();

    renderWith(makeFullPayload({
      thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false, hostAlertsEnabled: false },
    }));
    expand('recovery');
    expect(within(itemRow('Host thresholds')).getByText('Off')).toBeInTheDocument();
    expect(within(domainRow('recovery')).getByText('0/3')).toBeInTheDocument();
  });

  it('pluralizes counts correctly', () => {
    renderWith(makeFullPayload());
    expand('security');
    expect(within(itemRow('Scan policies')).getByText('2 policies')).toBeInTheDocument();
  });
});

describe('ConfigurationSummary drill-downs', () => {
  it.each([
    ['notifications', 'Channels', { kind: 'settings', section: 'notifications' }],
    ['notifications', 'Mute rules', { kind: 'settings', section: 'notification-suppression' }],
    ['automation', 'Auto-heal policies', { kind: 'settings', section: 'container-alerts' }],
    ['automation', 'Auto-update schedules', { kind: 'view', view: 'auto-updates' }],
    ['automation', 'Scheduled tasks', { kind: 'view', view: 'scheduled-ops' }],
    ['security', 'MFA', { kind: 'settings', section: 'account' }],
    ['security', 'Trivy', { kind: 'security', tab: 'scanner' }],
    ['security', 'Scan policies', { kind: 'security', tab: 'policies' }],
    ['recovery', 'Crash detection', { kind: 'settings', section: 'container-alerts' }],
  ])('%s / %s opens where it is managed', (domain, label, target) => {
    const { navigation } = renderWith(makeFullPayload());
    expand(domain);

    fireEvent.click(itemRow(label));
    expect(navigation.open).toHaveBeenCalledWith(target);
  });

  it('leaves a row inert when its destination is not reachable for this role', () => {
    const navigation = makeNavigation(target => !(target.kind === 'settings' && target.section === 'account'));
    renderWith(makeFullPayload(), false, navigation);
    expand('security');

    const mfa = itemRow('MFA');
    expect(within(mfa).queryByRole('button')).toBeNull();
    fireEvent.click(mfa);
    expect(navigation.open).not.toHaveBeenCalled();
    expect(within(itemRow('SSO')).getByRole('button', { name: 'SSO: Google' })).toBeInTheDocument();
  });
});

describe('ConfigurationSummary labels', () => {
  it('names a recognised SSO provider and falls back for an unknown one', () => {
    const { unmount } = renderWith(makeFullPayload());
    expand('security');
    expect(within(itemRow('SSO')).getByText('Google')).toBeInTheDocument();
    unmount();

    renderWith(makeFullPayload({
      security: { ...makeFullPayload().security, ssoProvider: 'oidc_mystery' },
    }));
    expand('security');
    expect(within(itemRow('SSO')).getByText('On')).toBeInTheDocument();
  });

  it('distinguishes unset, disabled, and enabled MFA', () => {
    for (const [mfaEnabled, expected] of [[null, 'Not set up'], [false, 'Off'], [true, 'On']] as const) {
      const { unmount } = renderWith(makeFullPayload({ security: { ...makeFullPayload().security, mfaEnabled } }));
      expand('security');
      expect(within(itemRow('MFA')).getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });

  it('distinguishes the backup providers', () => {
    for (const [backup, expected] of [
      [{ provider: 'disabled', autoUpload: false, locked: false }, 'Off'],
      [{ provider: 'sencho', autoUpload: false, locked: false }, 'Recovery Vault'],
      [{ provider: 'custom', autoUpload: true, locked: false }, 'Custom S3 (auto)'],
    ] as const) {
      const { unmount } = renderWith(makeFullPayload({ backup }));
      expand('recovery');
      expect(within(itemRow('Backups')).getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('ConfigurationSummary legacy remote agents', () => {
  it('summarizes enabled channels from a payload that omits apprise and ntfy', () => {
    const payload = makeFullPayload();
    const legacyAgents = {
      discord: { configured: true, enabled: true },
      slack: { configured: true, enabled: false },
      webhook: { configured: true, enabled: true },
    } as unknown as ConfigurationStatusPayload['notifications']['agents'];
    renderWith({ ...payload, notifications: { ...payload.notifications, agents: legacyAgents } });

    expect(within(domainRow('notifications')).getByText(/^Discord, Webhook · /)).toBeInTheDocument();
  });
});
