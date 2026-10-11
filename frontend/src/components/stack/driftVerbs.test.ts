import { describe, it, expect } from 'vitest';
import { resolveDriftFinding, type DriftVerbContext } from './driftVerbs';
import type { DriftFindingKind } from '@/types/drift';

const FULL: DriftVerbContext = { canDeploy: true, hasRedeploy: true, hasEditor: true, hasGitSource: true };

function resolve(kind: DriftFindingKind, ctx: DriftVerbContext = FULL, imageAge?: 'running-newer' | 'running-older' | 'unknown') {
  return resolveDriftFinding({ kind, service: 'web', imageAge }, ctx);
}

describe('resolveDriftFinding', () => {
  it.each<[DriftFindingKind, string | undefined]>([
    ['image-mismatch', 'redeploy'],
    ['ports-mismatch', 'redeploy'],
    ['network-undeclared', 'redeploy'],
    ['network-missing', 'open-editor'],
    ['service-missing', 'start-service'],
    ['service-undeclared', 'open-editor'],
    ['managed-path-conflict', 'open-git-source'],
  ])('%s leads with %s', (kind, expected) => {
    expect(resolve(kind).primary?.kind).toBe(expected);
  });

  it('makes the consequential redeploy a two-click verb and the safe ones one click', () => {
    expect(resolve('ports-mismatch').primary).toMatchObject({ kind: 'redeploy', clicks: 2 });
    expect(resolve('service-missing').primary).toMatchObject({ kind: 'start-service', clicks: 1 });
    expect(resolve('service-undeclared').primary).toMatchObject({ clicks: 1 });
  });

  it('leads with the editor when the running image is provably newer, and warns in the redeploy confirm', () => {
    const resolution = resolve('image-mismatch', FULL, 'running-newer');
    expect(resolution.primary?.kind).toBe('open-editor');
    const redeploy = resolution.secondary[0];
    expect(redeploy).toMatchObject({ kind: 'redeploy' });
    expect(redeploy.kind === 'redeploy' && redeploy.confirm).toMatch(/older compose image/);
  });

  it('leads with redeploy when the image age is older or unknown', () => {
    expect(resolve('image-mismatch', FULL, 'running-older').primary?.kind).toBe('redeploy');
    expect(resolve('image-mismatch', FULL, 'unknown').primary?.kind).toBe('redeploy');
    expect(resolve('image-mismatch').primary?.kind).toBe('redeploy');
  });

  it('offers the editor as a secondary verb beside redeploy and start', () => {
    expect(resolve('ports-mismatch').secondary.map(v => v.kind)).toEqual(['open-editor']);
    expect(resolve('service-missing').secondary.map(v => v.kind)).toEqual(['redeploy']);
  });

  it('drops verbs the account cannot run so the next one leads, never a 403', () => {
    const viewer = { ...FULL, canDeploy: false };
    expect(resolve('ports-mismatch', viewer).primary?.kind).toBe('open-editor');
    expect(resolve('service-missing', viewer).primary).toBeNull();
    expect(resolve('service-missing', viewer).secondary).toEqual([]);
  });

  it('drops the editor when the account cannot edit the stack, so no verb is a dead button', () => {
    const deployer = { ...FULL, hasEditor: false };
    expect(resolve('ports-mismatch', deployer).primary?.kind).toBe('redeploy');
    expect(resolve('ports-mismatch', deployer).secondary).toEqual([]);
    expect(resolve('service-undeclared', deployer).primary).toBeNull();
  });

  it('drops redeploy when the host mounted no deploy handler but keeps start-service', () => {
    const ctx = { ...FULL, hasRedeploy: false };
    expect(resolve('ports-mismatch', ctx).primary?.kind).toBe('open-editor');
    expect(resolve('service-missing', ctx).primary?.kind).toBe('start-service');
    expect(resolve('service-missing', ctx).secondary).toEqual([]);
  });

  it('names a remediation for every kind', () => {
    const kinds: DriftFindingKind[] = [
      'service-missing', 'service-undeclared', 'image-mismatch', 'ports-mismatch',
      'network-undeclared', 'network-missing', 'managed-path-conflict',
    ];
    for (const kind of kinds) expect(resolve(kind).remediation.length).toBeGreaterThan(10);
  });
});
