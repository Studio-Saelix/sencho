import { describe, it, expect } from 'vitest';
import type { PostureReason } from '@/types/security';
import { resolveReasonVerb, type ReasonVerbContext } from '../securityVerbs';

function reason(partial: Partial<PostureReason> & Pick<PostureReason, 'kind'>): PostureReason {
  return { count: 1, severity: 'review', label: 'x', description: 'x', targetTab: 'images', ...partial };
}

const ctx = (overrides: Partial<ReasonVerbContext> = {}): ReasonVerbContext => ({
  canManageNode: true,
  canScanNode: true,
  canDeployStack: () => true,
  canEditStack: () => true,
  scannerAvailable: true,
  updateChecksDisabled: false,
  isReplica: false,
  ...overrides,
});

const resolve = (r: PostureReason, c = ctx()) => resolveReasonVerb(r, c, 'Open →');

describe('resolveReasonVerb', () => {
  it('updates per stack, only the stacks the account may deploy', () => {
    const r = reason({
      kind: 'fixable_cve',
      severity: 'blocker',
      targets: [
        { imageRef: 'a', stackName: 'web', serviceName: 'app' },
        { imageRef: 'a', stackName: 'blog', serviceName: 'app' },
        { imageRef: 'a', stackName: 'web', serviceName: 'worker' },
      ],
    });
    expect(resolve(r, ctx({ canDeployStack: s => s === 'web' }))).toEqual({
      kind: 'review-update', label: 'Review update', clicks: 2, stacks: ['web'],
    });
  });

  it('falls back to navigation for image-only targets from an older remote, or when no stack may be deployed', () => {
    const imageOnly = reason({ kind: 'fixable_cve', severity: 'blocker', targets: [{ imageRef: 'a' }] });
    expect(resolve(imageOnly)).toMatchObject({ kind: 'navigate' });
    const withStack = reason({ kind: 'fixable_cve', severity: 'blocker', targets: [{ imageRef: 'a', stackName: 'web', serviceName: 'app' }] });
    expect(resolve(withStack, ctx({ canDeployStack: () => false }))).toMatchObject({ kind: 'navigate' });
  });

  it('sets exposure intent per service the account may edit, once each', () => {
    const r = reason({
      kind: 'public_exposure',
      targets: [
        { imageRef: 'a', stackName: 'web', serviceName: 'app' },
        { imageRef: 'a', stackName: 'web', serviceName: 'app' },
        { imageRef: 'b', stackName: 'blog', serviceName: 'app' },
      ],
    });
    expect(resolve(r, ctx({ canEditStack: s => s === 'web' }))).toEqual({
      kind: 'set-exposure-intent', label: 'Set exposure intent', clicks: 2, services: [{ stack: 'web', service: 'app' }],
    });
    expect(resolve(r, ctx({ canEditStack: () => false }))).toMatchObject({ kind: 'navigate' });
  });

  it('checks again only with node management and update checks on', () => {
    const r = reason({ kind: 'update_check_uncertain' });
    expect(resolve(r)).toMatchObject({ kind: 'check-again', clicks: 1 });
    expect(resolve(r, ctx({ canManageNode: false }))).toMatchObject({ kind: 'navigate' });
    expect(resolve(r, ctx({ updateChecksDisabled: true }))).toMatchObject({ kind: 'navigate' });
  });

  it('rescans only with the global node scan permission and a ready scanner', () => {
    const r = reason({ kind: 'stale_scan', severity: 'info' });
    expect(resolve(r)).toMatchObject({ kind: 'rescan-node' });
    expect(resolve(r, ctx({ scannerAvailable: false }))).toMatchObject({ kind: 'navigate' });
    // A node-scoped grant passes the update recheck but not the node scan, which takes no resource.
    expect(resolve(r, ctx({ canScanNode: false, canManageNode: true }))).toMatchObject({ kind: 'navigate' });
  });

  it('keeps the tab shortcut for secrets and Compose risks, which list every item there', () => {
    expect(resolve(reason({ kind: 'secret', severity: 'blocker' }))).toMatchObject({ kind: 'navigate' });
    expect(resolve(reason({ kind: 'dangerous_compose', severity: 'blocker' }))).toMatchObject({ kind: 'navigate' });
  });

  it('offers triage in the same page, but not on a replica', () => {
    const r = reason({ kind: 'needs_review', targetTab: 'suppressions' });
    expect(resolve(r)).toMatchObject({ kind: 'navigate', label: 'Triage' });
    expect(resolve(r, ctx({ isReplica: true }))).toBeNull();
  });

  it('opens History for failed scans and keeps the named navigation for the rest', () => {
    expect(resolve(reason({ kind: 'failed_scan', severity: 'info' }))).toMatchObject({ label: 'Open History' });
    expect(resolve(reason({ kind: 'known_exploited', severity: 'blocker' }))).toEqual({ kind: 'navigate', label: 'Open →', clicks: 1 });
  });
});
