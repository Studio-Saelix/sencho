/**
 * What the hub saw when a Pilot's connection was refused for a reason it can
 * attribute to a node.
 *
 * Most of what stops a Pilot from connecting happens on the host, where the hub
 * sees nothing: a name that does not resolve, a TLS or CA failure, a proxy that
 * does not pass the WebSocket upgrade. The hub only learns of a Pilot that
 * reached it and was refused with a credential the hub itself signed: an
 * enrollment that had expired, one that was already used, or an expired tunnel
 * credential. Those three are recorded here, per node and in memory (a restart
 * forgets them, and the next attempt records them again), so the bootstrap and
 * the readiness check can name the cause instead of reporting a timeout.
 *
 * Only a token whose signature the hub verified is recorded, so nobody can
 * plant a refusal on a node by presenting a forged token.
 */

export type PilotRefusal = 'enrollment_expired' | 'enrollment_used' | 'credential_expired';

export interface PilotRefusalRecord {
  reason: PilotRefusal;
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

  /** Keep the newest refusal for the node. */
  public recordRefusal(nodeId: number, reason: PilotRefusal, at: number = Date.now()): void {
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
