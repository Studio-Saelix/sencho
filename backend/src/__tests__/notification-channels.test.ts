/**
 * Unit tests for notification channel helpers: masking, Apprise validation,
 * fail-closed stored parsing, and public DTO redaction.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAppriseConfig,
  maskWebhookUrl,
  normalizeAppriseStoredJson,
  parseStoredAppriseConfig,
  serializePublicAgent,
  serializePublicNotificationRoute,
  validateNotificationChannel,
} from '../helpers/notificationChannels';

describe('maskWebhookUrl', () => {
  it('redacts the token-bearing path of a Discord webhook URL', () => {
    const masked = maskWebhookUrl('https://discord.com/api/webhooks/123456789/SuP3rS3cr3tT0k3n');
    expect(masked).toBe('https://discord.com/<redacted>');
    expect(masked).not.toContain('SuP3rS3cr3tT0k3n');
  });

  it('redacts the path of a Slack webhook URL', () => {
    const masked = maskWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXXSECRET');
    expect(masked).toBe('https://hooks.slack.com/<redacted>');
    expect(masked).not.toContain('XXXXSECRET');
  });

  it('redacts a secret carried in the query string', () => {
    const masked = maskWebhookUrl('https://example.com/?token=abc123secret');
    expect(masked).toBe('https://example.com/<redacted>');
    expect(masked).not.toContain('abc123secret');
  });

  it('returns the bare origin when there is no path or query to hide', () => {
    expect(maskWebhookUrl('https://example.com')).toBe('https://example.com');
    expect(maskWebhookUrl('https://example.com/')).toBe('https://example.com');
  });

  it('strips embedded userinfo credentials (origin omits user:pass@)', () => {
    const masked = maskWebhookUrl('https://user:s3cr3t@example.com/');
    expect(masked).toBe('https://example.com');
    expect(masked).not.toContain('s3cr3t');
    expect(masked).not.toContain('user');
  });

  it('returns a placeholder for empty or non-string input', () => {
    expect(maskWebhookUrl('')).toBe('<no url>');
    expect(maskWebhookUrl(undefined)).toBe('<no url>');
    expect(maskWebhookUrl(null)).toBe('<no url>');
    expect(maskWebhookUrl(42)).toBe('<no url>');
  });

  it('returns a placeholder for an unparseable URL', () => {
    expect(maskWebhookUrl('not a url')).toBe('<invalid url>');
  });
});

describe('Apprise channel helpers', () => {
  it('accepts empty keyed configuration (missing, null, or {})', () => {
    const endpoint = 'http://apprise.local/notify/key';
    expect(validateNotificationChannel('apprise', endpoint)).toBeNull();
    expect(validateNotificationChannel('apprise', endpoint, null)).toBeNull();
    expect(validateNotificationChannel('apprise', endpoint, {})).toBeNull();
    expect(classifyAppriseConfig(endpoint, null)).toEqual({ mode: 'keyed' });
    expect(normalizeAppriseStoredJson(endpoint, null)).toBe('{}');
    expect(normalizeAppriseStoredJson(endpoint, { tags: '' })).toBe('{}');
    expect(normalizeAppriseStoredJson(endpoint, { tags: 'ops' })).toBe(JSON.stringify({ tags: 'ops' }));
  });

  it('validates and classifies keyed and stateless configurations', () => {
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/key', { tags: 'ops' })).toBeNull();
    expect(classifyAppriseConfig('http://apprise.local/notify', { urls: 'discord://token slack://token' })).toEqual({
      mode: 'stateless',
      urls: ['discord://token', 'slack://token'],
    });
    expect(validateNotificationChannel('apprise', 'https://apprise.local/notify/key', { urls: 'discord://token' }))
      .toMatch(/urls|unknown/);
  });

  it('rejects unknown config keys and scheme-less destination tokens', () => {
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/key', { tags: 'ops', extra: 1 }))
      .toMatch(/unknown Apprise config field/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify', { urls: 'discord://ok', mode: 'stateless' }))
      .toMatch(/public summary|unknown/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify', { urls: 'not-a-scheme-token' }))
      .toMatch(/URI scheme/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify', { urls: 'discord://ok', tags: 'x' }))
      .toMatch(/tags/);
  });

  it('redacts Apprise endpoint keys and service URLs from public agents', () => {
    const secret = 'discord://webhook-id/webhook-token?secret=query';
    const agent = serializePublicAgent({
      id: 1,
      type: 'apprise',
      url: 'https://apprise.local/notify/key-secret',
      enabled: true,
      config: JSON.stringify({ tags: 'ops' }),
    });

    expect(agent).toMatchObject({
      type: 'apprise',
      url: 'https://apprise.local/notify/<redacted>',
      config: { mode: 'keyed', tags: 'ops', has_urls: false },
      secrets_redacted: true,
    });
    expect(JSON.stringify(agent)).not.toContain(secret);
  });

  it('never leaks Apprise secrets from userinfo, host, path, or query in public DTOs', () => {
    const secrets = [
      'userinfo-secret',
      'host-token.example',
      'path-secret',
      'query-secret',
    ];
    const urls = [
      'discord://userinfo-secret@host/path-secret?token=query-secret',
      'feishu://host-token.example/path-secret',
      'jira://APIKey:userinfo-secret@host/path-secret?token=query-secret',
    ].join(' ');

    const agent = serializePublicAgent({
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: JSON.stringify({ urls }),
    });
    const route = serializePublicNotificationRoute({
      id: 1,
      name: 'r',
      node_id: null,
      stack_patterns: [],
      label_ids: null,
      categories: null,
      channel_type: 'apprise',
      channel_url: 'http://apprise.local/notify/path-secret',
      config: JSON.stringify({ tags: 'ops' }),
      priority: 0,
      enabled: true,
      created_at: 1,
      updated_at: 1,
    });

    const blob = JSON.stringify({ agent, route });
    for (const secret of secrets) {
      expect(blob).not.toContain(secret);
    }
    expect(agent.config).toMatchObject({
      mode: 'stateless',
      has_urls: true,
      providers: expect.arrayContaining(['discord', 'feishu', 'jira']),
      url_count: 3,
    });
    expect(route.channel_url).toBe('http://apprise.local/notify/<redacted>');
  });

  it('rejects public DTO config shapes on validate', () => {
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify', {
      mode: 'stateless',
      has_urls: true,
      providers: ['discord'],
      url_count: 1,
    })).toMatch(/raw Apprise config/);
  });

  it('fail-closes malformed stored JSON and never exposes raw tokens as providers', () => {
    const keyed = parseStoredAppriseConfig('http://apprise.local/notify/key', '{not-json');
    expect(keyed).toEqual({ ok: false, reason: 'Apprise configuration is missing or invalid' });

    const badToken = parseStoredAppriseConfig(
      'http://apprise.local/notify',
      JSON.stringify({ urls: 'super-secret-token' }),
    );
    expect(badToken.ok).toBe(false);

    const agent = serializePublicAgent({
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: JSON.stringify({ urls: 'super-secret-token' }),
    });
    expect(agent.config).toBeNull();
    expect(JSON.stringify(agent)).not.toContain('super-secret-token');
  });

  it('treats null/empty stored config as valid empty keyed', () => {
    expect(parseStoredAppriseConfig('http://apprise.local/notify/key', null)).toEqual({ ok: true, mode: 'keyed' });
    expect(parseStoredAppriseConfig('http://apprise.local/notify/key', '{}')).toEqual({ ok: true, mode: 'keyed' });
    expect(parseStoredAppriseConfig('http://apprise.local/notify', null).ok).toBe(false);
  });
});
