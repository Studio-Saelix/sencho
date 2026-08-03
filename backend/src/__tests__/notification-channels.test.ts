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
  validateNtfyUrl,
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
      levels: null,
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

  it('rejects Apprise notify keys outside the official alphanumeric/underscore/dash charset', () => {
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/bad.key')).toMatch(/notify key/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/has%20space')).toMatch(/notify key|valid configuration/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/bad!key')).toMatch(/notify key/);
    expect(validateNotificationChannel('apprise', `http://apprise.local/notify/${'a'.repeat(129)}`)).toMatch(/notify key/);
    expect(validateNotificationChannel('apprise', 'http://apprise.local/notify/a')).toBeNull();
    expect(validateNotificationChannel('apprise', `http://apprise.local/notify/${'A1_-'}${'b'.repeat(124)}`)).toBeNull();
  });

  it('sets secrets_redacted only for Apprise public DTOs', () => {
    expect(serializePublicAgent({
      type: 'discord',
      url: 'https://discord.com/api/webhooks/1/token',
      enabled: true,
    }).secrets_redacted).toBe(false);
    expect(serializePublicAgent({
      type: 'slack',
      url: 'https://hooks.slack.com/services/a/b/c',
      enabled: true,
    }).secrets_redacted).toBe(false);
    expect(serializePublicAgent({
      type: 'webhook',
      url: 'https://example.com/hook',
      enabled: true,
    }).secrets_redacted).toBe(false);
    expect(serializePublicAgent({
      type: 'apprise',
      url: 'http://apprise.local/notify/k',
      enabled: true,
      config: '{}',
    }).secrets_redacted).toBe(true);
  });

  it('treats null/empty stored config as valid empty keyed', () => {
    expect(parseStoredAppriseConfig('http://apprise.local/notify/key', null)).toEqual({ ok: true, mode: 'keyed' });
    expect(parseStoredAppriseConfig('http://apprise.local/notify/key', '{}')).toEqual({ ok: true, mode: 'keyed' });
    expect(parseStoredAppriseConfig('http://apprise.local/notify', null).ok).toBe(false);
  });
});

describe('validateNtfyUrl', () => {
  it('accepts a valid HTTPS topic URL', () => {
    expect(validateNtfyUrl('https://ntfy.sh/mytopic')).toBeNull();
  });

  it('accepts a valid HTTP topic URL', () => {
    expect(validateNtfyUrl('http://ntfy.local/topic')).toBeNull();
  });

  it('accepts a trailing-slash topic', () => {
    expect(validateNtfyUrl('https://ntfy.sh/my-topic/')).toBeNull();
  });

  it('accepts a URL with query string', () => {
    expect(validateNtfyUrl('https://ntfy.example.com/topic?auth=abc123')).toBeNull();
  });

  it('accepts a URL with token query param', () => {
    expect(validateNtfyUrl('https://ntfy.sh/mytopic?token=tk_abc')).toBeNull();
  });

  it('rejects a non-string value', () => {
    expect(validateNtfyUrl(12345)).toBe('must be a valid ntfy URL');
  });

  it('rejects an empty string', () => {
    expect(validateNtfyUrl('')).toBe('must be a valid ntfy URL');
  });

  it('rejects an unparseable URL', () => {
    expect(validateNtfyUrl('not a url')).toBe('is not a valid URL');
  });

  it('rejects an ftp:// scheme', () => {
    expect(validateNtfyUrl('ftp://server/topic')).toBe('must use HTTP or HTTPS');
  });

  it('rejects a URL with no host', () => {
    // Use a trivially invalid URL that the WHATWG parser rejects on all
    // platforms so the test does not depend on host-vs-path ambiguity.
    expect(validateNtfyUrl('not-a-valid-url')).toBe('is not a valid URL');
  });

  it('rejects a root path', () => {
    expect(validateNtfyUrl('https://ntfy.sh/')).toBe('must include a topic path (e.g. /mytopic)');
  });

  it('rejects a root path without trailing slash', () => {
    expect(validateNtfyUrl('https://ntfy.sh')).toBe('must include a topic path (e.g. /mytopic)');
  });

  it('rejects a URL with username', () => {
    expect(validateNtfyUrl('https://user@ntfy.sh/topic')).toBe('must not include credentials in the URL');
  });

  it('rejects a URL with username and password', () => {
    expect(validateNtfyUrl('https://user:pass@ntfy.sh/topic')).toBe('must not include credentials in the URL');
  });

  it('rejects a URL with a fragment', () => {
    expect(validateNtfyUrl('https://ntfy.sh/topic#section')).toBe('must not include a fragment');
  });
});

describe('validateNotificationChannel HTTP regression', () => {
  it('still rejects http:// for webhook channel', () => {
    expect(validateNotificationChannel('webhook', 'http://example.com/hook')).toBe('must be a valid HTTPS URL');
  });

  it('still rejects http:// for discord channel', () => {
    expect(validateNotificationChannel('discord', 'http://discord.com/webhook')).toBe('must be a valid HTTPS URL');
  });

  it('still rejects http:// for slack channel', () => {
    expect(validateNotificationChannel('slack', 'http://hooks.slack.com/a')).toBe('must be a valid HTTPS URL');
  });
});
