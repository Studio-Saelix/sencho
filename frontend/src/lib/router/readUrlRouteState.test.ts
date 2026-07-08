import { describe, it, expect, beforeEach } from 'vitest';
import { readUrlRouteState } from './readUrlRouteState';

describe('readUrlRouteState', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/nodes/local/dashboard');
  });

  it('reads fleet from the current URL', () => {
    window.history.replaceState({}, '', '/nodes/local/fleet/snapshots');
    expect(readUrlRouteState().activeView).toBe('fleet');
    expect(readUrlRouteState().fleetActiveTab).toBe('snapshots');
  });

  it('reads security tab from the current URL', () => {
    window.history.replaceState({}, '', '/nodes/local/security/images');
    expect(readUrlRouteState().activeView).toBe('security');
    expect(readUrlRouteState().securityTab).toBe('images');
  });

  it('defaults to dashboard for unknown segments', () => {
    window.history.replaceState({}, '', '/nodes/local/not-a-view');
    expect(readUrlRouteState().activeView).toBe('dashboard');
  });
});
