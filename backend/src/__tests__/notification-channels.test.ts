/**
 * Unit tests for notification channel helpers. Focused on maskWebhookUrl,
 * which must never let a channel's embedded auth token reach a log line.
 */
import { describe, it, expect } from 'vitest';
import { maskWebhookUrl } from '../helpers/notificationChannels';

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
