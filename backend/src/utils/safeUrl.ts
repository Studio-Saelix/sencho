/**
 * Build a URL for a remote node API call. Constructs the URL from a
 * pre-validated apiUrl base and a path, guaranteeing the result stays
 * on the configured target origin. Marked as a CodeQL SSRF barrier via
 * the companion model file (.github/codeql/extensions/safeUrl.model.yml).
 */
export function buildRemoteApiUrl(apiUrl: string, path: string): string {
    const base = new URL(apiUrl);
    return new URL(path, base).toString();
}
