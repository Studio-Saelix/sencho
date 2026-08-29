import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { auditActorUsername } from '../helpers/auditActor';

describe('auditActorUsername', () => {
  it('prefers deployContext actor over machine identity username', () => {
    const req = {
      user: { username: 'node-proxy', role: 'admin' as const, userId: 0 },
      deployContext: { source: 'from_git' as const, actor: 'fleet-operator' },
    } satisfies Pick<Request, 'user' | 'deployContext'>;
    expect(auditActorUsername(req)).toBe('fleet-operator');
  });

  it('falls back to session username when deployContext actor is absent', () => {
    const req = {
      user: { username: 'admin', role: 'admin' as const, userId: 1 },
    } satisfies Pick<Request, 'user' | 'deployContext'>;
    expect(auditActorUsername(req)).toBe('admin');
  });

  it('returns unknown when no actor or user is present', () => {
    const req = {} as Pick<Request, 'user' | 'deployContext'>;
    expect(auditActorUsername(req)).toBe('unknown');
  });
});
