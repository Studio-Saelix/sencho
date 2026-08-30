/**
 * Validation for operator-supplied custom CA PEM bundles.
 * Accepts one or more PEM certificates; rejects empty or non-PEM input.
 */
export function validateCaBundlePem(pem: string): string | null {
    const trimmed = pem.trim();
    if (!trimmed) return null;
    if (!/-----BEGIN CERTIFICATE-----/.test(trimmed)) return null;
    if (!/-----END CERTIFICATE-----/.test(trimmed)) return null;
    return trimmed;
}

/** Normalize HTTPS credential scope host for comparison (host[:port], lowercase). */
export function credentialScopeHost(host: string, port?: number): string {
    const normalizedHost = host.trim().toLowerCase();
    if (!port || port === 443) return normalizedHost;
    if (normalizedHost.includes(':')) return normalizedHost;
    return `${normalizedHost}:${port}`;
}
