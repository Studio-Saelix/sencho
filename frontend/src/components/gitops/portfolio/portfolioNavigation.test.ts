/**
 * The application view's URL contract: opening pushes a linkable entry that
 * keeps the router's history marker, closing pops that entry when this module
 * pushed it and drops the parameter in place when the view was a direct link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_QUERY_PARAM,
  GITOPS_APPLICATION_EVENT,
  GITOPS_BLUEPRINT_EVENT,
  GITOPS_GIT_SOURCE_EVENT,
  applicationIdFromSearch,
  attentionNextStep,
  closeGitOpsApplication,
  openBlueprintInPlace,
  openGitOpsApplication,
  portfolioRowActions,
  type GitOpsBlueprintRequest,
  type GitOpsGitSourceTarget,
} from './portfolioNavigation';
import { portfolioRow } from '../application/applicationFixtures';
import { BLUEPRINT_INTENT_EVENT, type BlueprintIntent } from '@/lib/blueprintIntent';
import { SENCHO_NAVIGATE_EVENT, SENCHO_OPEN_STACK_EVENT, type SenchoNavigateDetail, type SenchoOpenStackDetail } from '@/lib/events';
import { clearBlueprintIntent } from '@/lib/blueprintIntent';

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

  it('offers a Direct row its Git source and stack, never a separate application page', () => {
    const labels = portfolioRowActions(direct, { canOpenFleet: true }).map(action => action.label);
    expect(labels).toEqual(['Open Git source', 'Open stack']);
    const git = portfolioRowActions(direct, { canOpenFleet: true }).find(action => action.label === 'Open Git source')!;
    expect(captured<GitOpsGitSourceTarget>(GITOPS_GIT_SOURCE_EVENT, git.run))
      .toEqual([{ nodeId: direct.nodeId, stackName: direct.stackName, applicationName: direct.name }]);
    // In place: the Git source opens over the workplace, never by switching to the stack.
    expect(captured<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, git.run)).toEqual([]);
  });

  it('opens a Direct source failure Git source in place when the session cannot retry it', () => {
    const next = attentionNextStep('source_failed', direct);
    expect(next.label).toBe('Open Git source');
    expect(captured<GitOpsGitSourceTarget>(GITOPS_GIT_SOURCE_EVENT, next.run))
      .toEqual([{ nodeId: direct.nodeId, stackName: direct.stackName, applicationName: direct.name }]);
    expect(captured<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, next.run)).toEqual([]);
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

  it.each([
    ['source_failed', 'retry'],
    ['source_retry_scheduled', 'retry'],
    ['source_unknown_outcome', 'retry'],
    ['source_suspended', 'resume'],
  ] as const)('runs %s as %s in place when the session may', (reason, action) => {
    const next = attentionNextStep(reason, direct, { can: wanted => wanted === action });
    expect(next.label).toBe(action === 'resume' ? 'Resume' : 'Retry');
  });

  it('falls back to opening the Git source when the session may not run the verb', () => {
    expect(attentionNextStep('source_suspended', direct, { can: () => false }).label).toBe('Open Git source');
  });

  it('opens a Direct pending update review in the Git source, which pulls and shows the diff', () => {
    const next = attentionNextStep('source_review_pending', direct);
    expect(next.label).toBe('Review update');
    expect(captured<GitOpsGitSourceTarget>(GITOPS_GIT_SOURCE_EVENT, next.run))
      .toEqual([{ nodeId: direct.nodeId, stackName: direct.stackName, applicationName: direct.name, intent: 'review' }]);
  });

  it('opens the application for a Blueprint failure, which has no single stack', () => {
    expect(attentionNextStep('deploy_failed', blueprint).label).toBe('Open');
  });
});

describe('openBlueprintInPlace', () => {
  afterEach(() => clearBlueprintIntent());

  function listen<T>(type: string, run: () => void, take?: (detail: T) => void): T[] {
    const seen: T[] = [];
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<T>).detail;
      seen.push(detail);
      take?.(detail);
    };
    window.addEventListener(type, handler);
    try { run(); } finally { window.removeEventListener(type, handler); }
    return seen;
  }

  it('stays in the workplace when a host takes the request', () => {
    let navigated: SenchoNavigateDetail[] = [];
    let intents: BlueprintIntent[] = [];
    const requests = listen<GitOpsBlueprintRequest>(GITOPS_BLUEPRINT_EVENT, () => {
      navigated = listen<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, () => {
        intents = listen<BlueprintIntent>(BLUEPRINT_INTENT_EVENT, () => openBlueprintInPlace({ kind: 'open', blueprintId: 4 }));
      });
    }, request => { request.handled = true; });
    expect(requests).toHaveLength(1);
    expect(requests[0].intent).toEqual({ kind: 'open', blueprintId: 4 });
    expect(navigated).toEqual([]);
    expect(intents).toEqual([]);
  });

  it('falls back to the Fleet Blueprints tab when nothing hosts it', () => {
    const navigated = listen<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, () => openBlueprintInPlace({ kind: 'create' }));
    expect(navigated).toEqual([{ view: 'fleet', fleetTab: 'deployments' }]);
  });

  it('is what a Blueprint row opens', () => {
    const row = portfolioRow({ id: 'bp:3', targetMode: 'blueprint', nodeId: null, stackName: null, blueprintId: 3 });
    const open = portfolioRowActions(row, { canOpenFleet: true }).find(action => action.label === 'Open Blueprint')!;
    const requests = listen<GitOpsBlueprintRequest>(GITOPS_BLUEPRINT_EVENT, open.run, r => { r.handled = true; });
    expect(requests.map(r => r.intent)).toEqual([{ kind: 'open', blueprintId: 3 }]);
  });
});

