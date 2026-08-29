import type { Request } from 'express';

/** Prefer trusted proxy provenance over the machine identity username. */
export function auditActorUsername(req: Pick<Request, 'user' | 'deployContext'>): string {
  const actor = req.deployContext?.actor;
  if (typeof actor === 'string' && actor.trim().length > 0) {
    return actor.trim();
  }
  return req.user?.username ?? 'unknown';
}
