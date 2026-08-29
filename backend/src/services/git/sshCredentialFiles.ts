import { promises as fs } from 'fs';
import path from 'path';
import { canonicalizeDeployKeyPem, canonicalizeKnownHostsEntry } from './sshTrust';

/** Materialize a validated deploy key PEM for one git/ssh invocation (mode 0600). */
export async function writeDeployKey(metaDir: string, pem: string): Promise<string> {
    const keyPath = path.join(metaDir, 'deploy-key');
    const canonical = canonicalizeDeployKeyPem(pem);
    await fs.writeFile(keyPath, canonical, { mode: 0o600 });
    return keyPath.split(path.sep).join('/');
}

/** Materialize a validated known_hosts entry for one git/ssh invocation (mode 0600). */
export async function writeKnownHosts(metaDir: string, entry: string): Promise<string> {
    const knownHostsPath = path.join(metaDir, 'known_hosts');
    const canonical = canonicalizeKnownHostsEntry(entry);
    await fs.writeFile(knownHostsPath, canonical, { mode: 0o600 });
    return knownHostsPath.split(path.sep).join('/');
}
