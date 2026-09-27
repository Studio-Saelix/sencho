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
  attentionNextStep,
  closeGitOpsApplication,
  openGitOpsApplication,
  portfolioRowActions,
} from './portfolioNavigation';
import { portfolioRow } from '../application/applicationFixtures';
import { BLUEPRINT_INTENT_EVENT, type BlueprintIntent } from '@/lib/blueprintIntent';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';

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

describe('portfolio row actions and attention next steps', () => {
  const direct = portfolioRow();
  const blueprint = portfolioRow({ id: 'bp:3', targetMode: 'blueprint', nodeId: null, stackName: null, blueprintId: 3 });

  function captured<T>(event: string, run: () => void): T[] {
    const seen: T[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent<T>).detail);
    window.addEventListener(event, onEvent);
    try { run(); } finally { window.removeEventListener(event, onEvent); }
    return seen;
  }

  it('offers a Direct row its application, stack, and Git source', () => {
    const labels = portfolioRowActions(direct, { canOpenFleet: true }).map(action => action.label);
    expect(labels).toEqual(['Open application', 'Open stack', 'Open Git source']);
    const git = portfolioRowActions(direct, { canOpenFleet: true }).find(action => action.label === 'Open Git source')!;
    expect(captured<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, git.run))
      .toEqual([{ nodeId: direct.nodeId, stackName: direct.stackName, destination: 'git' }]);
  });

  it('offers a Blueprint row its Blueprint only when Fleet is reachable', () => {
    expect(portfolioRowActions(blueprint, { canOpenFleet: false }).map(action => action.label)).toEqual(['Open application']);
    const open = portfolioRowActions(blueprint, { canOpenFleet: true }).find(action => action.label === 'Open Blueprint')!;
    expect(captured<BlueprintIntent>(BLUEPRINT_INTENT_EVENT, open.run)).toEqual([{ kind: 'open', blueprintId: 3 }]);
  });

  it('does not offer a Fleet handoff for a node-scoped remote Blueprint', () => {
    const remoteBlueprint = portfolioRow({ id: '2:app-remote-bp', targetMode: 'blueprint', nodeId: 2, stackName: null, blueprintId: 3 });
    expect(portfolioRowActions(remoteBlueprint, { canOpenFleet: true }).map(action => action.label)).toEqual(['Open application']);
  });

  it('does not offer a decision action for a node-scoped remote Blueprint', () => {
    const remoteBlueprint = portfolioRow({ id: '2:app-remote-bp', targetMode: 'blueprint', nodeId: 2, stackName: null, blueprintId: 3 });
    expect(attentionNextStep('rollout_authorization_pending', remoteBlueprint).label).toBe('Inspect');
  });

  it('opens the application when inspecting a node-scoped remote Blueprint', () => {
    const remoteBlueprint = portfolioRow({ id: '2:app-remote-bp', targetMode: 'blueprint', nodeId: 2, stackName: null, blueprintId: 3 });
    const step = attentionNextStep('rollout_authorization_pending', remoteBlueprint);
    step.run();
    expect(applicationIdFromSearch(window.location.search)).toBe('2:app-remote-bp');
  });

  it('sends a pending decision to the application view, where the authority actions live', () => {
    const step = attentionNextStep('rollout_authorization_pending', blueprint);
    expect(step.label).toBe('Review');
    step.run();
    expect(applicationIdFromSearch(window.location.search)).toBe('bp:3');
  });

  it('sends a Direct runtime failure to the stack and a source failure to its Git source', () => {
    expect(attentionNextStep('deploy_failed', direct).label).toBe('Open stack');
    expect(captured<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, attentionNextStep('health_failed', direct).run)[0]?.destination).toBe('stack');
    expect(attentionNextStep('source_failed', direct).label).toBe('Open Git source');
  });

  it('opens the application for a Blueprint failure, which has no single stack', () => {
    expect(attentionNextStep('deploy_failed', blueprint).label).toBe('Open');
  });
});
