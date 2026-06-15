/**
 * Covers the capability-gated Doctor tab and its severity dot in
 * StackAnatomyPanel when the active node advertises compose-doctor. The
 * capability-off case (tab hidden, no badge fetch) is covered in
 * StackAnatomyPanel.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('./stack/StackActivityTimeline', () => ({ StackActivityTimeline: () => <div /> }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 }, hasCapability: () => true }) }));

import { apiFetch } from '@/lib/api';
import StackAnatomyPanel from './StackAnatomyPanel';

let badgeSeverity: string | null = 'blocker';

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/preflight')) {
      return jsonRes({ stack: 'web', ranAt: 1, ranBy: 'x', renderable: true, renderError: null, status: 'high', highestSeverity: badgeSeverity, findings: [] });
    }
    return jsonRes(null, false); // git-source, update-preview, scan-status
  });
});

function panel() {
  return (
    <StackAnatomyPanel
      stackName="web"
      content={'services:\n  web:\n    image: nginx:1.25\n'}
      envContent=""
      selectedEnvFile=".env"
      gitSourcePending={false}
      onEditCompose={vi.fn()}
      onOpenGitSource={vi.fn()}
      onApplyUpdate={vi.fn()}
      canEdit
    />
  );
}

describe('StackAnatomyPanel Doctor tab (capability on)', () => {
  it('renders the Doctor tab with a destructive dot for a blocker result', async () => {
    badgeSeverity = 'blocker';
    render(panel());
    expect(await screen.findByTestId('doctor-tab')).toBeInTheDocument();
    const dot = await screen.findByTestId('doctor-tab-dot');
    expect(dot.className).toContain('bg-destructive');
  });

  it('uses the warning color for a high-risk result', async () => {
    badgeSeverity = 'high';
    render(panel());
    const dot = await screen.findByTestId('doctor-tab-dot');
    expect(dot.className).toContain('bg-warning');
  });

  it('shows no dot for a warning-only result', async () => {
    badgeSeverity = 'warning';
    render(panel());
    await screen.findByTestId('doctor-tab');
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/preflight'))).toBe(true));
    expect(screen.queryByTestId('doctor-tab-dot')).not.toBeInTheDocument();
  });

  it('renders the Networking tab when the capability is present', async () => {
    badgeSeverity = 'warning';
    render(panel());
    expect(await screen.findByTestId('networking-tab')).toBeInTheDocument();
  });
});
