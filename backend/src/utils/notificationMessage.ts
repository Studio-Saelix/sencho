const MAX_MESSAGE_CHARS = 1000;
// U+2026 ellipsis (one codepoint), not three ASCII dots; tests assert this exact suffix.
const TRUNCATION_SUFFIX = '… [truncated]';

// KEY=VALUE pairs whose KEY ends in a sensitive suffix. Values are stripped
// because compose-parse errors and docker run failures surface them verbatim.
// PASSWORD covers the bare-PASS case; standalone PASS would over-redact
// BYPASS, COMPASS, and similar non-secret keys.
const SENSITIVE_KEY_PATTERN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET|CREDENTIALS?|AUTH))\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

const URL_BASIC_AUTH = /\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)([^/\s:@]+):([^/\s:@]+)@/g;
const BEARER_TOKEN = /\b(Bearer)\s+([A-Za-z0-9._\-+/=]{8,})/g;

export function sanitizeNotificationMessage(raw: string, opts: { composeDir?: string } = {}): string {
    if (!raw) return raw;
    let s = raw;

    s = s.replace(SENSITIVE_KEY_PATTERN, (_m, key) => `${key}=<redacted>`);
    s = s.replace(URL_BASIC_AUTH, (_m, scheme, user) => `${scheme}${user}:<redacted>@`);
    s = s.replace(BEARER_TOKEN, (_m, kw) => `${kw} <redacted>`);

    if (opts.composeDir) {
        const escaped = opts.composeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(escaped, 'g'), '<compose-dir>');
    }

    if (s.length > MAX_MESSAGE_CHARS) {
        s = s.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
    }

    return s;
}
