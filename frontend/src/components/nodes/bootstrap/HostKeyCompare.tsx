/** The server's host key file that matches the algorithm the hub observed. */
function hostKeyFilePath(algorithm: string): string {
  if (algorithm === 'ssh-ed25519') return '/etc/ssh/ssh_host_ed25519_key.pub';
  if (algorithm === 'ssh-rsa') return '/etc/ssh/ssh_host_rsa_key.pub';
  if (algorithm.startsWith('ecdsa-sha2-')) return '/etc/ssh/ssh_host_ecdsa_key.pub';
  return '/etc/ssh/ssh_host_*_key.pub';
}

/** `host algorithm base64` becomes `algorithm base64`, the first two fields of a .pub file. */
function publicKeyLine(knownHostsLine: string): string {
  return knownHostsLine.trim().split(/\s+/).slice(1).join(' ');
}

/**
 * What the operator needs to check a host key on the server: the command that
 * prints the fingerprint and the public key line the hub saw. The line is empty
 * after a live key change, where only the fingerprint was observed.
 */
export function HostKeyCompare({ algorithm, knownHostsLine }: { algorithm: string; knownHostsLine: string }) {
  const line = publicKeyLine(knownHostsLine);
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground">
        Compare it with <code className="font-mono">ssh-keygen -lf {hostKeyFilePath(algorithm)}</code> on the server.
      </p>
      {line && (
        <code
          data-testid="host-key-line"
          className="block break-all rounded bg-muted/40 px-2 py-1 font-mono text-[10px] text-stat-subtitle"
        >
          {line}
        </code>
      )}
    </div>
  );
}
