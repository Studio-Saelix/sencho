/**
 * PolicyPacksTab renders the static catalog and, crucially, fetches it with
 * { localOnly: true } so the global catalog is available regardless of which
 * node is active.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { PolicyPacksTab } from '../PolicyPacksTab';
import type { PolicyPack } from '@/types/security';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PACKS: PolicyPack[] = [
  {
    id: 'homelab-baseline',
    name: 'Homelab baseline',
    tagline: 'Gentle defaults.',
    tierCopy: 'Advisory.',
    rules: [
      { id: 'pin-image-tag', name: 'Pin image tags', severity: 'LOW', whatItChecks: 'tags', why: 'reproducible', howToFix: 'pin', enforcement: 'warning' },
    ],
  },
  {
    id: 'strict-production',
    name: 'Strict production',
    tagline: 'Zero tolerance.',
    tierCopy: 'Strict.',
    rules: [
      { id: 'no-privileged', name: 'No privileged containers', severity: 'CRITICAL', whatItChecks: 'priv', why: 'escape', howToFix: 'drop', enforcement: 'enforceable' },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(jsonResponse(200, PACKS));
});

it('fetches the catalog with localOnly and reveals rules when a pack is expanded', async () => {
  const user = userEvent.setup();
  render(<PolicyPacksTab />);
  await waitFor(() => expect(screen.getByText('Homelab baseline')).toBeInTheDocument());
  expect(screen.getByText('Strict production')).toBeInTheDocument();
  expect(mockedFetch).toHaveBeenCalledWith('/security/policy-packs', { localOnly: true });

  // Rules are collapsed behind the accordion until the pack header is clicked.
  expect(screen.queryByText('Pin image tags')).not.toBeInTheDocument();
  await user.click(screen.getByText('Homelab baseline'));
  await user.click(screen.getByText('Strict production'));
  expect(screen.getByText('Pin image tags')).toBeInTheDocument();
  expect(screen.getByText('No privileged containers')).toBeInTheDocument();
});

it('labels expanded rules as warning or enforceable', async () => {
  const user = userEvent.setup();
  render(<PolicyPacksTab />);
  await waitFor(() => expect(screen.getByText('Homelab baseline')).toBeInTheDocument());
  await user.click(screen.getByText('Homelab baseline'));
  await user.click(screen.getByText('Strict production'));
  expect(screen.getByText('Warning')).toBeInTheDocument();
  expect(screen.getByText('Enforceable')).toBeInTheDocument();
});
