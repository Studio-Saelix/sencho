/**
 * Per-agent notification payload templates.
 *
 * A template is an optional user-authored JSON document on a notification
 * agent. When set, the rendered JSON replaces the built-in body for that
 * channel. Substitution is plain `{{key}}` replacement (no templating
 * engine). A variable must appear inside a JSON string: as the whole string
 * (`"{{message}}"`) or glued to other text (`"status: {{level}}"`); every
 * occurrence is replaced with the JSON-escaped value, so quotes or newlines
 * inside a value cannot break the document. Validation substitutes every
 * known variable with a placeholder and requires the result to parse, so a
 * save-valid template stays valid when real values are substituted.
 */

export const PAYLOAD_TEMPLATE_VARS = ['level', 'message', 'category', 'timestamp', 'stack_name', 'actor'] as const;
export type PayloadTemplateVar = (typeof PAYLOAD_TEMPLATE_VARS)[number];

/** Upper bound on template length, enforced before substitution. */
export const PAYLOAD_TEMPLATE_MAX_LENGTH = 8000;

/** Placeholders used in place of every known variable during validation. */
const QUOTED_PLACEHOLDER = '"__sencho_template_value__"';
const BARE_PLACEHOLDER = '__sencho_template_value__';

/**
 * Matches a known variable token, derived from PAYLOAD_TEMPLATE_VARS so the
 * vocabulary has one source of truth. The quoted alternative comes first so
 * `"{{message}}"` is consumed as one unit (the template's quotes are
 * replaced by the injected JSON string literal); a bare `{{message}}` is
 * matched by the second alternative wherever it sits inside a string and is
 * replaced with the escaped string content, without surrounding quotes.
 */
const TEMPLATE_VAR_ALTERNATION = PAYLOAD_TEMPLATE_VARS.join('|');
const TEMPLATE_VAR_REGEX = new RegExp(
    `"\\{\\{(${TEMPLATE_VAR_ALTERNATION})\\}\\}"|\\{\\{(${TEMPLATE_VAR_ALTERNATION})\\}\\}`,
    'g',
);
const UNKNOWN_VAR_REGEX = /\{\{([^{}]+)\}\}/g;

/** Escaped JSON string content without surrounding quotes (for in-string substitution). */
function escapeStringContent(value: string | undefined): string {
    const literal = JSON.stringify(value ?? '');
    return literal.slice(1, -1);
}

function substitutePlaceholders(template: string): string {
    return substituteVars(template, (name, quoted) => (quoted ? QUOTED_PLACEHOLDER : BARE_PLACEHOLDER));
}

function substituteVars(template: string, inject: (name: string, quoted: boolean) => string): string {
    // The two alternatives each capture the variable name into a different
    // group (1 quoted, 2 bare), so read whichever matched.
    return template.replace(TEMPLATE_VAR_REGEX, (_match, quoted?: string, bare?: string) =>
        inject(quoted ?? bare ?? '', quoted !== undefined),
    );
}

export type PayloadTemplateValidation =
    | { ok: true; value: string | null }
    | { ok: false; error: string };

/**
 * Validate a payload template. `undefined`/null/blank (after trim) resolve to
 * null (built-in payload). Otherwise the template must be a string, at most
 * PAYLOAD_TEMPLATE_MAX_LENGTH characters, reference only known variables as
 * complete `{{var}}` tokens with no unterminated `{{` left over, and parse
 * as JSON after placeholder substitution.
 */
export function validatePayloadTemplate(raw: unknown): PayloadTemplateValidation {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, error: 'must be a string' };
    const trimmed = raw.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (trimmed.length > PAYLOAD_TEMPLATE_MAX_LENGTH) {
        return { ok: false, error: `must be ${PAYLOAD_TEMPLATE_MAX_LENGTH} characters or fewer` };
    }

    const substituted = substitutePlaceholders(trimmed);
    const unknownTokens = [...substituted.matchAll(UNKNOWN_VAR_REGEX)].map(m => m[1]);
    if (unknownTokens.length > 0) {
        const named = unknownTokens.map(token => `{{${token}}}`).join(', ');
        return {
            ok: false,
            error: `Unknown template variable: ${named}. Allowed variables: ${PAYLOAD_TEMPLATE_VARS.join(', ')}.`,
        };
    }
    // A leftover `{{` can only be an unterminated or stray variable token
    // (complete unknown tokens are rejected above); `}}` alone is legitimate
    // JSON, for example a nested object's closing braces.
    if (substituted.includes('{{')) {
        return { ok: false, error: 'must not contain an unterminated or stray {{token}}; each variable must be a complete {{name}} token' };
    }

    try {
        JSON.parse(substituted);
    } catch {
        return { ok: false, error: 'must be valid JSON after substituting template variables' };
    }
    return { ok: true, value: trimmed };
}

/**
 * Top-level keys of the parsed template document after placeholder
 * substitution. Empty when the document does not parse as a JSON object.
 * Used to keep Apprise destination fields (`urls`/`tag`) managed by the
 * channel configuration rather than the template.
 */
export function templateTopLevelKeys(template: string): string[] {
    const substituted = substitutePlaceholders(template);
    try {
        const parsed = JSON.parse(substituted) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.keys(parsed as Record<string, unknown>);
        }
    } catch {
        // Invalid JSON is rejected by validatePayloadTemplate before this is called.
    }
    return [];
}

/**
 * Channel-specific template restrictions shared by both write endpoints.
 * Apprise destinations (`urls`/`tag`) are managed by the channel fields and
 * merged server-side at dispatch, so Apprise templates must render a
 * non-empty JSON object and must not carry those keys. Returns an error
 * message, or null when the template is allowed.
 */
export function assertPayloadTemplateAllowedForChannel(template: string, type: string): string | null {
    if (type !== 'apprise') return null;
    const keys = templateTopLevelKeys(template);
    const forbidden = keys.filter(key => key === 'urls' || key === 'tag');
    if (keys.length === 0) return 'must render a JSON object';
    if (forbidden.length > 0) {
        return `must not include ${forbidden.join(' or ')}; Apprise destinations are managed by the channel fields`;
    }
    return null;
}

/**
 * Resolve a payload template write for either route. `raw` undefined keeps
 * the stored value; otherwise validate, apply the channel-specific gate, and
 * return the normalized template (null when blank).
 */
export function resolvePayloadTemplate(
    raw: unknown,
    stored: string | null | undefined,
    type: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, value: stored ?? null };
    const validated = validatePayloadTemplate(raw);
    if (!validated.ok) return validated;
    if (validated.value !== null) {
        const channelErr = assertPayloadTemplateAllowedForChannel(validated.value, type);
        if (channelErr) return { ok: false, error: channelErr };
    }
    return validated;
}

/**
 * Render a validated template with concrete values. Missing context becomes
 * an empty string. Values are JSON-escaped via JSON.stringify, so the result
 * parses whenever the template passed validation. Throws a plain Error on
 * parse failure (callers that deliver externally wrap it as a non-retryable
 * delivery error).
 */
export function renderPayloadTemplate(template: string, vars: Record<string, string | undefined>): unknown {
    const rendered = substituteVars(template, (name, quoted) =>
        quoted ? JSON.stringify(vars[name] ?? '') : escapeStringContent(vars[name]),
    );
    try {
        return JSON.parse(rendered) as unknown;
    } catch {
        throw new Error('Templated payload rendered invalid JSON');
    }
}
