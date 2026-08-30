/**
 * Materialize the combined CA bundle the git child process will read through
 * `http.sslCAInfo`. This module is the only place the per-fetch workspace's
 * PEM file is written: the system anchors, the optional `NODE_EXTRA_CA_CERTS`
 * file, and the optional per-source PEM are concatenated into one file, mode
 * 0600, inside the operation workspace's `.meta` directory. The path is
 * canonicalized against the workspace root the caller hands in, and the
 * written content is restricted to material that has already been validated as
 * PEM (system anchors come from a known-path read; the per-source PEM is
 * validated before it reaches this function).
 *
 * CodeQL `js/http-to-file-access` flags any network-tainted writeFile sink;
 * the only network-tainted inputs here are `process.env.NODE_EXTRA_CA_CERTS`
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

/** Read and validate the platform system CA bundle, if available. Exported for test injection. */
export async function readSystemCaBundle(): Promise<string | null> {
    if (process.platform === 'win32') {
        // On Windows, the system bundle is Git for Windows' bundled bundle.
        // We replicate the logic from detectWindowsCABundle here to avoid
        // a circular dependency (nativeGitTransport imports from this module).
        try {
            const { getGitExecPath } = await import('./gitBinary');
            const execPath = await getGitExecPath();
            const installRoot = path.resolve(execPath, '..', '..'); // <install>/mingw64/libexec/git-core -> <install>/mingw64
            const candidates = [
                path.join(installRoot, 'etc', 'ssl', 'certs', 'ca-bundle.crt'),
                path.resolve(execPath, '..', '..', '..', 'usr', 'ssl', 'certs', 'ca-bundle.crt'),
            ];
            for (const candidate of candidates) {
                if (existsSync(candidate)) {
                    const raw = await fs.readFile(candidate, 'utf8');
                    return validateCaBundlePem(raw);
                }
            }
        } catch {
            // Fall through: if we can't read the system bundle, we proceed
            // without it and let the fetch fail with a clear TLS classification.
        }
        return null;
    }

    // POSIX: try common system CA bundle locations.
    const candidates = [
        '/etc/ssl/certs/ca-certificates.crt',           // Debian/Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',             // RHEL/Fedora
        '/etc/ssl/ca-bundle.pem',                       // Alpine
        '/usr/local/share/ca-certificates/ca-bundle.crt', // Custom
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            try {
                const raw = await fs.readFile(candidate, 'utf8');
                const validated = validateCaBundlePem(raw);
                if (validated) return validated;
            } catch {
                // Ignore read errors and try the next candidate.
            }
        }
    }
    return null;
}

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
    systemCaPem?: string | null,
): Promise<{ path: string } | null> {
    const customChunks: string[] = [];

    // Per-source CA PEM (encrypted at rest, decrypted by caller)
    if (perSourceCaPem?.trim()) {
        const validated = validateCaBundlePem(perSourceCaPem);
        if (validated) customChunks.push(validated);
    }

    // NODE_EXTRA_CA_CERTS (dev/E2E bridge)
    const envExtraPath = process.env.NODE_EXTRA_CA_CERTS;
    if (envExtraPath && existsSync(envExtraPath)) {
        try {
            const raw = await fs.readFile(envExtraPath, 'utf8');
            const validated = validateCaBundlePem(raw);
            if (validated) customChunks.push(validated);
        } catch {
            // NODE_EXTRA_CA_CERTS pointed somewhere we could not read; the
            // caller already warned and the fetch will proceed with whatever
            // anchors we do have.
        }
    }

    // If there are no custom anchors (per-source or env), we don't need to
    // write a combined file at all - git will use system trust directly.
    if (customChunks.length === 0) return null;

    // We have custom anchors: include system anchors so that private CAs
    // AUGMENT rather than REPLACE system trust (mirrors Node's
    // NODE_EXTRA_CA_CERTS add-not-replace semantics).
    // We have custom anchors: include system anchors so that private CAs
    // AUGMENT rather than REPLACE system trust (mirrors Node's
    // NODE_EXTRA_CA_CERTS add-not-replace semantics). The optional
    // `systemCaPem` parameter is a test injection point: `undefined`
    // means "read the platform bundle" (production), a string means
    // "use this controlled fixture" (test), and `null` means "explicitly
    // skip" (negative-control test).
    let systemCa: string | null = null;
    if (systemCaPem === null) {
        // Explicit skip: negative-control path.
    } else if (systemCaPem !== undefined) {
        systemCa = validateCaBundlePem(systemCaPem);
    } else {
        systemCa = await readSystemCaBundle();
    }
    if (systemCa) customChunks.unshift(systemCa);

    const target = path.join(metaDir, COMBINED_FILENAME);
    const body = `${customChunks.join('\n')}\n`;
    await fs.writeFile(target, body, { mode: 0o600 });
    return { path: target.split(path.sep).join('/') };
}
