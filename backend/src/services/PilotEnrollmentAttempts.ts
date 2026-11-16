/**
 * What the hub saw when a Pilot's connection was refused for a reason it can
 * attribute to a node.
 *
 * Most of what stops a Pilot from connecting happens on the host, where the hub
 * sees nothing: a name that does not resolve, a TLS or CA failure, a proxy that
 * does not pass the WebSocket upgrade. The hub only learns of a Pilot that
 * reached it and was refused with a credential the hub itself signed: an
 * enrollment that had expired, one that was already used or replaced by a newer
 * one, or an expired tunnel credential. Those three are recorded here, per node and in memory (a restart
 * forgets them, and the next attempt records them again), so the bootstrap and
 * the readiness check can name the cause instead of reporting a timeout.
 *
 * Only a token whose signature the hub verified is recorded, so nobody can
 * plant a refusal on a node by presenting a forged token.
 *
 * A second kind of record comes from the host. When the bootstrap's wait for
 * the Pilot ends with nothing having reached the hub, the run reads the tail of
 * the agent's own log over its SSH session and names a cause only when a line
 * in it matches a known failure (a name that does not resolve, a certificate the
 * agent does not trust, a connection answered with an HTTP status instead of a
 * WebSocket upgrade). That is what the agent said about itself, recorded so the
 * readiness check can repeat it for the disconnected node, and a log that names
 * nothing records nothing.
 */

export type PilotRefusal = 'enrollment_expired' | 'enrollment_used' | 'credential_expired';

/** What the agent's log said stopped it from reaching the hub. */
export type PilotConnectFailure = 'dns_unresolved' | 'tls_untrusted' | 'upgrade_blocked';

export interface PilotRefusalRecord {
  reason: PilotRefusal | PilotConnectFailure;
  at: number;
}

/** A refusal per node is one small record; the cap only stops a pathological number of nodes from growing the map. */
const MAX_NODES = 1000;

export class PilotEnrollmentAttempts {
  private static instance: PilotEnrollmentAttempts | null = null;
  private readonly refusals = new Map<number, PilotRefusalRecord>();

  public static getInstance(): PilotEnrollmentAttempts {
    if (!PilotEnrollmentAttempts.instance) PilotEnrollmentAttempts.instance = new PilotEnrollmentAttempts();
    return PilotEnrollmentAttempts.instance;
  }

  /** Keep the newest refusal, or failure the agent's log named, for the node. */
  public recordRefusal(nodeId: number, reason: PilotRefusal | PilotConnectFailure, at: number = Date.now()): void {
    this.refusals.delete(nodeId);
    this.refusals.set(nodeId, { reason, at });
    if (this.refusals.size > MAX_NODES) {
      const oldest = this.refusals.keys().next().value;
      if (oldest !== undefined) this.refusals.delete(oldest);
    }
  }

  public lastRefusal(nodeId: number): PilotRefusalRecord | null {
    return this.refusals.get(nodeId) ?? null;
  }

  /** A new enrollment, or a connection the hub accepted, makes an earlier refusal history. */
  public clear(nodeId: number): void {
    this.refusals.delete(nodeId);
  }
}
