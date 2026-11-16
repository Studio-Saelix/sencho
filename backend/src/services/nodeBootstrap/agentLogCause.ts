import type { PilotConnectFailure } from '../PilotEnrollmentAttempts';
import { scrubSecrets } from './sshProbeClient';

/**
 * What the Pilot's own log says about why it could not reach the hub.
 *
 * A failure that happens before a connection reaches the hub (a name that does not resolve, a certificate the agent does
 * not trust, a reverse proxy that answers the upgrade request with a plain HTTP response) leaves nothing on the hub. The
 * agent does log it, in lines it writes itself (`[Pilot] Tunnel error: ...`, `[Pilot] Tunnel closed: <status>`), so the
 * bootstrap reads the tail of that log and names a cause only when the newest failure line matches one of the patterns
 * below. An older failure followed by a different one names nothing, and neither does a log that matches none or that
 * cannot be read: the cause stays unknown instead of being guessed.
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
/**
 * The statuses the hub's own tunnel handler answers an upgrade with (a missing or invalid credential, a wrong scope, a bad
 * or unknown node, a server error). A line carrying one cannot be told from a reverse proxy's answer, and the hub records
 * the refusals it signed itself, so it names nothing here.
 */
const HUB_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 500]);
/** A line the agent wrote about itself, with or without a timestamp in front. */
const AGENT_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}T\S+\s+)?\[Pilot\]/;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function bounded(line: string): string {
  const clean = line.replace(CONTROL, '').trim();
  return clean.length > EVIDENCE_MAX_CHARS ? `${clean.slice(0, EVIDENCE_MAX_CHARS)}...` : clean;
}

/**
 * The cause the newest failure line of the agent's log names, or null. Only lines the agent wrote about itself count, so
 * output from anything else in the container cannot name a cause. Lines that are not failures (a reconnect notice, a
 * close without a status) are skipped; the first failure line from the end decides, so a DNS error from boot does not
 * blame the cause of a later, different failure. A connection made after the failure, or a rejection the hub itself
 * sent, ends the search with nothing named.
 */
export function classifyAgentLog(log: string, secrets: string[] = []): AgentLogFinding | null {
  // Scrubbed whole first, so a secret that spans lines is caught as well as one inside a line.
  const lines = scrubSecrets(log, secrets).replace(ANSI, '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!AGENT_LINE.test(line)) continue;
    if (line.includes('Tunnel connected to') || line.includes('Tunnel upgrade rejected')) return null;
    const upgrade = UPGRADE.exec(line);
    if (upgrade) {
      const status = Number(upgrade[1]);
      return HUB_STATUSES.has(status) ? null : { cause: 'upgrade_blocked', evidence: bounded(line), status };
    }
    if (!line.includes('Tunnel error:')) continue;
    if (DNS.test(line)) return { cause: 'dns_unresolved', evidence: bounded(line), status: null };
    if (TLS.test(line)) return { cause: 'tls_untrusted', evidence: bounded(line), status: null };
    return null;
  }
  return null;
}
