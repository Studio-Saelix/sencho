/**
 * The application view's URL contract: opening pushes a linkable entry that
 * keeps the router's history marker, closing pops that entry when this module
 * pushed it and drops the parameter in place when the view was a direct link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_QUERY_PARAM,
  GITOPS_APPLICATION_EVENT,
  applicationIdFromSearch,
  closeGitOpsApplication,
  openGitOpsApplication,
} from './portfolioNavigation';

beforeEach(() => {
  window.history.replaceState({ senchoIdx: 4 }, '', '/nodes/local/gitops?mode=direct');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applicationIdFromSearch', () => {
  it('reads the application id, with or without the leading question mark', () => {
    expect(applicationIdFromSearch('?application=bp%3A3')).toBe('bp:3');
    expect(applicationIdFromSearch('application=1:abc')).toBe('1:abc');
  });

  it('answers null when absent, empty, or implausibly long', () => {
    expect(applicationIdFromSearch('?mode=direct')).toBeNull();
    expect(applicationIdFromSearch('?application=')).toBeNull();
    expect(applicationIdFromSearch(`?application=${'x'.repeat(513)}`)).toBeNull();
  });
});

describe('openGitOpsApplication', () => {
  it('pushes the application onto the current path and keeps the router marker', () => {
    const listener = vi.fn();
    window.addEventListener(GITOPS_APPLICATION_EVENT, listener);
    const push = vi.spyOn(window.history, 'pushState');

    openGitOpsApplication('2:legacy:Media Stack');

    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/nodes/local/gitops');
    expect(applicationIdFromSearch(window.location.search)).toBe('2:legacy:Media Stack');
    expect((window.history.state as { senchoIdx?: number }).senchoIdx).toBe(4);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(GITOPS_APPLICATION_EVENT, listener);
  });
});

describe('closeGitOpsApplication', () => {
  it('pops the entry it pushed, so the filtered list URL comes back', () => {
    openGitOpsApplication('bp:3');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    closeGitOpsApplication();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('drops the parameter in place for a directly linked view', () => {
    window.history.replaceState({ senchoIdx: 2 }, '', `/nodes/local/gitops?${APPLICATION_QUERY_PARAM}=bp%3A3`);
    const back = vi.spyOn(window.history, 'back');
    const listener = vi.fn();
    window.addEventListener(GITOPS_APPLICATION_EVENT, listener);

    closeGitOpsApplication();

    expect(back).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect((window.history.state as { senchoIdx?: number }).senchoIdx).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(GITOPS_APPLICATION_EVENT, listener);
  });
});
