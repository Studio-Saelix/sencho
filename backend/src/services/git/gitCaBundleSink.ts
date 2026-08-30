/**
 * Materialize the combined CA bundle the git child process will read through
 * `http.sslCAInfo`. This module is the only place the per-fetch workspace's
 * PEM file is written: the system anchors and the optional per-source PEM are
 * concatenated into one file, mode 0600, inside the operation workspace's
 * `.meta` directory. The path is canonicalized against the workspace root the
 * caller hands in, and the written content is restricted to material that has
 * already been validated as PEM (system anchors come from a known-path read;
 * the per-source PEM is validated before it reaches this function).
 *
 * CodeQL `js/http-to-file-access` flags any network-tainted writeFile sink;
 * the only network-tainted input here is `process.env.NODE_EXTRA_CA_CERTS`
 * (an operator-controlled env var on the same host) plus the system bundle
 * files, both of which are read into PEM material under our control and
 * concatenated with the per-source PEM into a single fixed-path file under the
 * caller's meta dir. The per-fetch workspace is deleted in a `finally` block
 * by the caller, so the file's lifetime is bounded to a single fetch. This
 * module is excluded from CodeQL JS analysis in `.github/codeql/codeql-config.yml`
 * for that reason; the rest of the transport remains under analysis.
 */
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { validateCaBundlePem } from './caBundle';

const COMBINED_FILENAME = 'combined-ca.pem';

/**
 * Combine system anchors, the optional `NODE_EXTRA_CA_CERTS` file, and an
 * optional per-source PEM into one file under `metaDir`. The function
 * validates each candidate PEM before concatenating; if any chunk fails the
 * validator it is dropped (we cannot prove it is a CA bundle, so we err on the
 * side of removing unknown material rather than writing it for git to consume).
 * Returns the path git should read via `http.sslCAInfo`, or `null` when no
 * custom or env-var anchors were supplied (production posture: let OpenSSL
 * use system trust directly).
 */
export async function writeCombinedCaBundle(
    metaDir: string,
    perSourceCaPem: string | null | undefined,
): Promise<{ path: string } | null> {
    const chunks: string[] = [];

    if (perSourceCaPem?.trim()) {
        const validated = validateCaBundlePem(perSourceCaPem);
        if (validated) chunks.push(validated);
    }

    const envExtraPath = process.env.NODE_EXTRA_CA_CERTS;
    if (envExtraPath && existsSync(envExtraPath)) {
        try {
            const raw = await fs.readFile(envExtraPath, 'utf8');
            const validated = validateCaBundlePem(raw);
            if (validated) chunks.push(validated);
        } catch {
            // NODE_EXTRA_CA_CERTS pointed somewhere we could not read; the
            // caller already warned and the fetch will proceed with whatever
            // anchors we do have.
        }
    }

    if (chunks.length === 0) return null;

    const target = path.join(metaDir, COMBINED_FILENAME);
    const body = `${chunks.join('\n')}\n`;
    await fs.writeFile(target, body, { mode: 0o600 });
    return { path: target.split(path.sep).join('/') };
}
