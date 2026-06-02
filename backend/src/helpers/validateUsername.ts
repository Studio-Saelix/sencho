/**
 * Shared username rule for account creation. Used by the user-management route
 * and the emergency `create-emergency-admin` CLI so both enforce the same shape
 * (no whitespace, slashes, or control characters that would produce odd
 * accounts or malformed audit paths).
 *
 * Returns an error message, or null when the value is acceptable.
 */
export function validateUsername(value: unknown): string | null {
    if (typeof value !== 'string' || value.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
        return 'Username must be at least 3 characters (letters, numbers, underscore, hyphen)';
    }
    return null;
}
