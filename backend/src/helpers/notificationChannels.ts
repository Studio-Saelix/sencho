export const NOTIFICATION_CHANNEL_TYPES = ['discord', 'slack', 'webhook'] as const;
export type NotificationChannelType = typeof NOTIFICATION_CHANNEL_TYPES[number];

export const cleanStackPatterns = (patterns: string[]): string[] =>
  [...new Set(patterns.map(p => p.trim()).filter(Boolean))];

export function validateHttpsUrl(value: unknown): string | null {
  if (!value || typeof value !== 'string' || !value.startsWith('https://')) return 'must be a valid HTTPS URL';
  try { new URL(value); } catch { return 'is not a valid URL'; }
  return null;
}

/**
 * Mask a channel webhook URL for logging. Discord/Slack/custom webhook URLs
 * embed their auth token in the path (and sometimes the query), so only the
 * origin is safe to emit. Returns `https://host/<redacted>` or a generic
 * placeholder if the value is not a parseable URL.
 */
export function maskWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<no url>';
  try {
    const { origin, pathname, search } = new URL(value);
    // pathname is normalized to '/' for an origin-only URL, so anything else
    // (or any query string) is a token-bearing segment we must not log.
    const hasSecret = pathname !== '/' || search !== '';
    return hasSecret ? `${origin}/<redacted>` : origin;
  } catch {
    return '<invalid url>';
  }
}
