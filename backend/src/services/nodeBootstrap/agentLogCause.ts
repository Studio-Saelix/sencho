import type { PilotConnectFailure } from '../PilotEnrollmentAttempts';
import { scrubSecrets } from './sshProbeClient';

/**
 * What the Pilot's own log says about why it could not reach the hub.
 *
 * A failure that happens before a connection reaches the hub (a name that does not resolve, a certificate the agent does
 * not trust, a reverse proxy that answers the upgrade request with a plain HTTP response) leaves nothing on the hub. The
 * agent does log it, in lines it writes itself (`[Pilot] Tunnel error: ...`, `[Pilot] Tunnel closed: <status>`), so the
 * bootstrap reads the tail of that log and names a cause only when a line matches one of the patterns below. A log that
 * matches none, or that cannot be read, names nothing: the cause stays unknown instead of being guessed.
 */

export interface AgentLogFinding {
  cause: PilotConnectFailure;
  /** The line that named it, scrubbed and bounded, kept as the evidence. */
  evidence: string;
  /** The HTTP status an upgrade attempt was answered with, for `upgrade_blocked`. */
  status: number | null;
}

/** One log line is kept to this many characters as evidence. */
const EVIDENCE_MAX_CHARS = 200;

const DNS = /\b(?:ENOTFOUND|EAI_AGAIN)\b/;
const TLS = /(?:unable to verify the first certificate|unable to get local issuer certificate|self[- ]signed certificate|certificate has expired|certificate is not yet valid|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate)/i;
// The agent logs the status of an upgrade that was refused twice: `Tunnel closed: 200 ` and `Unexpected server response: 200`.
const UPGRADE = /(?:\[Pilot\] Tunnel closed:\s*|Unexpected server response:\s*)(\d{3})\b/;
/** A 401 is the hub itself turning a credential away; it is read from what the hub recorded, not from the agent's log. */
const HUB_ANSWER = 401;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]|\u001b\[[0-9;]*[A-Za-z]/g;

function bounded(line: string, secrets: string[]): string {
  const clean = scrubSecrets(line.replace(CONTROL, ''), secrets).trim();
  return clean.length > EVIDENCE_MAX_CHARS ? `${clean.slice(0, EVIDENCE_MAX_CHARS)}...` : clean;
}

/**
 * The newest line of the agent's log that names a known connection failure, or null. Only lines the agent wrote about
 * itself (`[Pilot]`) count, so output from anything else in the container cannot name a cause.
 */
export function classifyAgentLog(log: string, secrets: string[] = []): AgentLogFinding | null {
  // Scrubbed whole first, so a secret that spans lines is caught as well as one inside a line.
  const lines = scrubSecrets(log, secrets).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('[Pilot]')) continue;
    // A connection that was made after the failure ends the search: what came before it is history.
    if (line.includes('[Pilot] Tunnel connected to')) return null;
    const upgrade = UPGRADE.exec(line);
    if (upgrade && Number(upgrade[1]) !== HUB_ANSWER) {
      return { cause: 'upgrade_blocked', evidence: bounded(line, secrets), status: Number(upgrade[1]) };
    }
    if (DNS.test(line)) return { cause: 'dns_unresolved', evidence: bounded(line, secrets), status: null };
    if (TLS.test(line)) return { cause: 'tls_untrusted', evidence: bounded(line, secrets), status: null };
  }
  return null;
}
