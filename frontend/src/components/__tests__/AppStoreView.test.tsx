/**
 * Verifies that an App Store install binds both the runWithLog session and the
 * /templates/deploy POST to the node captured when the install starts, so the
 * install does not retarget if the active node changes while images pull. The
 * heavy child components are stubbed to a minimal select-then-deploy path.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const dfCtl = vi.hoisted(() => ({ params: null as null | { stackName: string; action: string; nodeId: number | null } }));

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  withDeploySession: (ds: string, options: RequestInit = {}) => ({
    ...options,
    headers: { ...(options.headers as Record<string, string> | undefined), 'x-deploy-session-id': ds },
  }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 5, type: 'local', name: 'local' } }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: vi.fn(
      async (
        params: { stackName: string; action: string; nodeId: number | null },
        run: (started: Promise<void>, ds: string) => Promise<{ ok: boolean }>,
      ) => {
        dfCtl.params = params;
        return run(Promise.resolve(), 'ds-1');
      },
    ),
  }),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/appstore/CategorySidebar', () => ({ CategorySidebar: () => null }));
// Both featured and grid surfaces select the template; whichever renders, one
// select button exists.
vi.mock('@/components/appstore/TemplateTile', () => ({
  TemplateTile: ({ template, onSelect }: { template: { title: string }; onSelect: (t: unknown) => void }) => (
    <button data-testid="select-template" onClick={() => onSelect(template)}>{template.title}</button>
  ),
}));
vi.mock('@/components/appstore/FeaturedHero', () => ({
  FeaturedHero: ({ template, onOpen }: { template: { title: string }; onOpen: (t: unknown) => void }) => (
    <button data-testid="select-template" onClick={() => onOpen(template)}>{template.title}</button>
  ),
}));
vi.mock('@/components/ui/system-sheet', () => ({
  SystemSheet: ({ open, primaryAction }: { open: boolean; primaryAction?: { onClick: () => void; disabled?: boolean } }) =>
    open && primaryAction
      ? <button data-testid="deploy" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>deploy</button>
      : null,
  SheetSection: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { apiFetch } from '@/lib/api';
import { AppStoreView } from '../AppStoreView';

const TEMPLATE = {
  title: 'Nginx',
  description: 'web server',
  categories: ['Web'],
  env: [],
  ports: [],
  volumes: [],
  architectures: [],
};

beforeEach(() => {
  dfCtl.params = null;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/templates/deploy')) return Promise.resolve(jsonRes({}));
    if (u.includes('/templates')) return Promise.resolve(jsonRes([TEMPLATE]));
    if (u.includes('/stacks')) return Promise.resolve(jsonRes([]));
    return Promise.resolve(jsonRes({}));
  });
});

describe('AppStoreView install node binding', () => {
  it('binds both runWithLog and the /templates/deploy POST to the captured node', async () => {
    render(<AppStoreView onDeploySuccess={vi.fn()} />);

    fireEvent.click((await screen.findAllByTestId('select-template'))[0]);
    fireEvent.click(await screen.findByTestId('deploy'));

    await waitFor(() => {
      const deployCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/templates/deploy'));
      expect(deployCall?.[1]).toEqual(expect.objectContaining({ nodeId: 5 }));
    });
    expect(dfCtl.params).toEqual(expect.objectContaining({ action: 'install', nodeId: 5 }));
  });
});
