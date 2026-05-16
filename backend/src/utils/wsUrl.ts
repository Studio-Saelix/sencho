/**
 * Convert an HTTP(S) base URL to a WebSocket URL by upgrading the scheme.
 * Maps `http://` to `ws://` and `https://` to `wss://`; trims a trailing
 * slash so the caller can append a path. Other schemes pass through
 * unchanged because the caller may already have a `ws://` or `wss://`
 * URL.
 *
 * Existed previously as inline regex replacements in several places that
 * either dropped the trailing slash unevenly or used `replace(/^http/, 'ws')`
 * which silently downgrades `https://` to `ws://` (cleartext). This helper
 * is the single correct form.
 */
export function httpUrlToWs(baseUrl: string): string {
    return baseUrl.replace(/\/$/, '').replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws'));
}
