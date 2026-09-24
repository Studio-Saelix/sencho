/**
 * Pure classifyStackApiPath coverage for hub stack RBAC gating.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStackApiPath,
  formatScopedStackActionsHeader,
  parseScopedStackActionsHeader,
} from '../helpers/stackRouteAuth';
import type { PermissionAction } from '../middleware/permissions';

describe('classifyStackApiPath', () => {
  describe('named-stack families', () => {
    it('maps read routes to stack:read', () => {
      expect(classifyStackApiPath('GET', '/stacks/web')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('GET', '/stacks/web/env')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('GET', '/stacks/web/git-source')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      // Load-bearing: an unclassified named-stack path is refused before the
      // admin bypass, so a missing rule here 403s this route on every remote
      // node for every caller.
      expect(classifyStackApiPath('GET', '/stacks/web/git-source/history')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('GET', '/stacks/web/git-source/manifest')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      // Hub-to-remote Blueprint digest observation; missing this rule fails
      // closed as unknown-named and 403s proxied callers (and non-admin hub callers).
      expect(classifyStackApiPath('GET', '/stacks/web/runtime-artifact-identity')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('GET', '/stacks/web/effective-artifact-context')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/drift/recheck')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
    });

    it('maps edit routes to stack:edit', () => {
      expect(classifyStackApiPath('PUT', '/stacks/web')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('PUT', '/stacks/web/env')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('PUT', '/stacks/web/git-source')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('DELETE', '/stacks/web/git-source')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/fleet-snapshot-apply')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
    });

    it('maps deploy routes and service lifecycle ops to stack:deploy', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/deploy')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:deploy',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/update')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:deploy',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/services/api/restart')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:deploy',
      });
      expect(classifyStackApiPath('GET', '/stacks/web/services/api/recovery')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:deploy',
      });
    });

    it('maps stack DELETE to stack:delete', () => {
      expect(classifyStackApiPath('DELETE', '/stacks/web')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:delete',
      });
    });

    it('treats git-source/apply primary as stack:edit', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/apply')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
    });

    it('treats pull-images primary as stack:edit', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/pull-images')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
    });

    // Load-bearing the same way as history/manifest above: without a rule
    // here, suspend/resume/retry 403 on every remote node before the
    // controller routes that use them exist.
    it('maps git-source/suspend, resume, and retry to stack:edit', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/suspend')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/resume')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/retry')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
    });

    it('maps all git-source/provider-hooks CRUD suffixes to the expected actions', () => {
      const hookId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      expect(classifyStackApiPath('GET', '/stacks/web/git-source/provider-hooks')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/provider-hooks')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('POST', `/stacks/web/git-source/provider-hooks/${hookId}/rotate`)).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('POST', `/stacks/web/git-source/provider-hooks/${hookId}/test-result`)).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('PATCH', `/stacks/web/git-source/provider-hooks/${hookId}`)).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
      expect(classifyStackApiPath('DELETE', `/stacks/web/git-source/provider-hooks/${hookId}`)).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:edit',
      });
    });
  });

  describe('static exclusions', () => {
    it('classifies collection and create paths as static', () => {
      expect(classifyStackApiPath('GET', '/stacks')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('GET', '/stacks/')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('POST', '/stacks')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('GET', '/stacks/statuses')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('GET', '/stacks/readiness-summary')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('GET', '/stacks/discovery')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('POST', '/stacks/import/scan')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('POST', '/stacks/import/move')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('POST', '/stacks/bulk')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('POST', '/stacks/from-git')).toEqual({ kind: 'static' });
    });

    it('classifies non-/stacks paths as static', () => {
      expect(classifyStackApiPath('GET', '/nodes')).toEqual({ kind: 'static' });
      expect(classifyStackApiPath('GET', '/users')).toEqual({ kind: 'static' });
    });
  });

  describe('encoding and trailing slashes', () => {
    it('decodes percent-encoded stack names', () => {
      expect(classifyStackApiPath('GET', '/stacks/my%2Dstack')).toEqual({
        kind: 'named-stack', stackName: 'my-stack', action: 'stack:read',
      });
      expect(classifyStackApiPath('POST', '/stacks/web%5Fprod/deploy')).toEqual({
        kind: 'named-stack', stackName: 'web_prod', action: 'stack:deploy',
      });
    });

    it('strips trailing slashes before matching', () => {
      expect(classifyStackApiPath('GET', '/stacks/web/')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/deploy/')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:deploy',
      });
      expect(classifyStackApiPath('GET', '/stacks/statuses/')).toEqual({ kind: 'static' });
    });

    it('ignores query strings', () => {
      expect(classifyStackApiPath('GET', '/stacks/web?nodeId=1')).toEqual({
        kind: 'named-stack', stackName: 'web', action: 'stack:read',
      });
    });
  });

  describe('fail-closed unknown-named', () => {
    it('returns unknown-named for git-source/adopt-blueprint, which stays hub-local', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/adopt-blueprint')).toEqual({
        kind: 'unknown-named',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/git-source/adopt-blueprint/preview')).toEqual({
        kind: 'unknown-named',
      });
    });

    it('returns unknown-named for unrecognized /stacks/<name>/... suffixes', () => {
      expect(classifyStackApiPath('GET', '/stacks/web/weird')).toEqual({ kind: 'unknown-named' });
      expect(classifyStackApiPath('POST', '/stacks/web/not-a-real-action')).toEqual({
        kind: 'unknown-named',
      });
      expect(classifyStackApiPath('POST', '/stacks/web/services/api/recovery')).toEqual({
        kind: 'unknown-named',
      });
    });

    // The index is exact-match, so registering one suffix never widens
    // authority to a lookalike neighbour.
    it('refuses the bare pull suffix that has no route', () => {
      expect(classifyStackApiPath('POST', '/stacks/web/pull')).toEqual({ kind: 'unknown-named' });
      expect(classifyStackApiPath('POST', '/stacks/web/pull-images/extra')).toEqual({
        kind: 'unknown-named',
      });
    });

    it('returns unknown-named for invalid stack name segments', () => {
      expect(classifyStackApiPath('GET', '/stacks/bad name')).toEqual({ kind: 'unknown-named' });
      expect(classifyStackApiPath('GET', '/stacks/%2E%2E')).toEqual({ kind: 'unknown-named' });
    });
  });
});

describe('scoped stack actions header encode/decode', () => {
  it('round-trips a PermissionAction set', () => {
    const actions: PermissionAction[] = ['stack:edit', 'stack:deploy', 'stack:read'];
    const encoded = formatScopedStackActionsHeader(actions);
    expect(parseScopedStackActionsHeader(encoded)).toEqual(actions);
  });

  it('returns null for malformed tokens', () => {
    expect(parseScopedStackActionsHeader('stack:edit,not-a-real-action')).toBeNull();
    expect(parseScopedStackActionsHeader('')).toBeNull();
    expect(parseScopedStackActionsHeader('   ')).toBeNull();
  });

  it('deduplicates while preserving first-seen order', () => {
    expect(parseScopedStackActionsHeader('stack:edit,stack:deploy,stack:edit')).toEqual([
      'stack:edit',
      'stack:deploy',
    ]);
  });
});
