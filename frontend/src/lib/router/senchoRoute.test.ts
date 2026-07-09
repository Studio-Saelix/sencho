import { describe, it, expect } from 'vitest';
import { buildPath, parsePath } from './senchoRoute';
import type { RouteState } from './routeTypes';

const base: RouteState = {
  nodeSlug: 'local',
  activeView: 'dashboard',
  stackName: null,
  editorTab: 'compose',
  envFile: null,
  securityTab: 'overview',
  fleetActiveTab: 'overview',
  settingsSection: 'appearance',
  filterNodeId: null,
  mobileSurface: null,
  isMobile: false,
};

describe('senchoRoute', () => {
  it('round-trips dashboard', () => {
    const path = buildPath(base);
    expect(path).toBe('/nodes/local/dashboard');
    const parsed = parsePath(path, '');
    expect(parsed.view).toBe('dashboard');
    expect(parsed.nodeSlug).toBe('local');
  });

  it('round-trips stack editor with tab and env query', () => {
    const full = buildPath({
      ...base,
      activeView: 'editor',
      stackName: 'radarr',
      editorTab: 'env',
      envFile: '.env.production',
    });
    expect(full).toBe('/nodes/local/stacks/radarr/env?env=.env.production');
    const q = full.indexOf('?');
    const parsed = parsePath(
      q === -1 ? full : full.slice(0, q),
      q === -1 ? '' : full.slice(q),
    );
    expect(parsed.view).toBe('editor');
    expect(parsed.stackName).toBe('radarr');
    expect(parsed.editorTab).toBe('env');
    expect(parsed.envFile).toBe('.env.production');
  });

  it('maps mobile stack list to /stacks without a stack segment', () => {
    const path = buildPath({
      ...base,
      isMobile: true,
      mobileSurface: 'list',
    });
    expect(path).toBe('/nodes/local/stacks');
    const parsed = parsePath(path, '');
    expect(parsed.isStackList).toBe(true);
    expect(parsed.view).toBe('dashboard');
  });

  it('maps mobile list surface to /stacks regardless of activeView', () => {
    const path = buildPath({
      ...base,
      isMobile: true,
      mobileSurface: 'list',
      activeView: 'fleet',
      fleetActiveTab: 'snapshots',
    });
    expect(path).toBe('/nodes/local/stacks');
  });

  it('parses fleet and settings sections', () => {
    const fleet = parsePath('/nodes/local/fleet/snapshots', '');
    expect(fleet.view).toBe('fleet');
    expect(fleet.fleetTab).toBe('snapshots');

    const settings = parsePath('/nodes/local/settings/nodes', '');
    expect(settings.view).toBe('settings');
    expect(settings.settingsSection).toBe('nodes');
  });

  it('normalizes trailing slashes and ignores unknown query keys', () => {
    const parsed = parsePath('/nodes/local/dashboard/', '?foo=bar');
    expect(parsed.view).toBe('dashboard');
    expect(parsed.nodeSlug).toBe('local');
  });

  it('rejects invalid node filter query values', () => {
    const parsed = parsePath('/nodes/local/stacks/radarr/compose', '?node=-1');
    expect(parsed.filterNodeId).toBeNull();
    const overflow = parsePath('/nodes/local/stacks/radarr/compose', '?node=999999999999999999999');
    expect(overflow.filterNodeId).toBeNull();
  });

  it('canonicalizes desktop settings to a concrete section', () => {
    const path = buildPath({ ...base, activeView: 'settings', settingsSection: 'appearance' });
    expect(path).toBe('/nodes/local/settings/appearance');
  });

  it('parses legacy absolute env query as basename', () => {
    const parsed = parsePath(
      '/nodes/local/stacks/radarr/env',
      '?env=%2Fhome%2Fuser%2Fcompose%2Fradarr%2F.env.prod',
    );
    expect(parsed.envFile).toBe('.env.prod');
  });

  it('rejects absolute paths in buildPath env query', () => {
    const path = buildPath({
      ...base,
      activeView: 'editor',
      stackName: 'radarr',
      editorTab: 'env',
      envFile: '/home/user/compose/radarr/.env.prod',
    });
    expect(path).toBe('/nodes/local/stacks/radarr/env');
  });

  it('rejects Windows paths in buildPath env query', () => {
    const path = buildPath({
      ...base,
      activeView: 'editor',
      stackName: 'radarr',
      editorTab: 'env',
      envFile: 'C:\\compose\\stack\\.env.prod',
    });
    expect(path).toBe('/nodes/local/stacks/radarr/env');
  });

  it('parses stack list path as mobile list surface', () => {
    const parsed = parsePath('/nodes/local/stacks', '');
    expect(parsed.isStackList).toBe(true);
    expect(parsed.stackName).toBeNull();
  });
});
