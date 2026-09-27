/**
 * The workplace's ways into GitOps: each opens the owning surface's own flow
 * (the Create Stack dialog's From Git tab, the Fleet Blueprints create dialog)
 * and appears only for a role that could complete it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BLUEPRINT_INTENT_EVENT, clearBlueprintIntent } from '@/lib/blueprintIntent';
import { SENCHO_NAVIGATE_EVENT, SENCHO_OPEN_CREATE_STACK_EVENT } from '@/lib/events';
import { WorkplaceActions } from './WorkplaceActions';

const grants = { can: new Set<string>(), fleet: false };

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: (permission: string) => grants.can.has(permission) }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ hasCapability: () => grants.fleet }),
}));

function grant(permissions: string[], fleet: boolean) {
  grants.can = new Set(permissions);
  grants.fleet = fleet;
}

function captured(event: string, run: () => void): unknown[] {
  const seen: unknown[] = [];
  const onEvent = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener(event, onEvent);
  try { run(); } finally { window.removeEventListener(event, onEvent); }
  return seen;
}

afterEach(() => clearBlueprintIntent());

describe('WorkplaceActions', () => {
  it('opens the Create Stack dialog on its From Git tab', () => {
    grant(['stack:create'], false);
    render(<WorkplaceActions />);
    const created = captured(SENCHO_OPEN_CREATE_STACK_EVENT, () => {
      fireEvent.click(screen.getByRole('button', { name: /connect a stack to git/i }));
    });
    expect(created).toEqual([{ mode: 'git' }]);
    // Fleet is not reachable, so no Blueprint path is offered.
    expect(screen.queryByRole('button', { name: /new blueprint/i })).toBeNull();
  });

  it('opens the Fleet Blueprints create dialog when Fleet is reachable', () => {
    grant(['stack:create', 'node:read'], true);
    render(<WorkplaceActions />);
    const button = screen.getByRole('button', { name: /new blueprint/i });
    const navigations = captured(SENCHO_NAVIGATE_EVENT, () => {
      const intents = captured(BLUEPRINT_INTENT_EVENT, () => fireEvent.click(button));
      expect(intents).toEqual([{ kind: 'create' }]);
    });
    expect(navigations).toEqual([{ view: 'fleet', fleetTab: 'deployments' }]);
  });

  it('renders nothing for a role that can create neither', () => {
    grant(['stack:read'], true);
    const { container } = render(<WorkplaceActions />);
    expect(container).toBeEmptyDOMElement();
  });
});
