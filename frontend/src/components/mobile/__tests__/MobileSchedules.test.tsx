/**
 * Confirms the mobile schedule view renders action short labels from the shared
 * registry rather than a local map, so a registry change flows through to mobile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScheduledTask } from '@/types/scheduling';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { MobileSchedules } from '../MobileSchedules';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const soon = Date.now() + 3_600_000;
  return {
    id: 1,
    name: 'task',
    target_type: 'stack',
    target_id: 'web',
    node_id: 1,
    action: 'auto_backup',
    cron_expression: '0 3 * * *',
    enabled: 1,
    created_by: 'admin',
    created_at: 0,
    updated_at: 0,
    last_run_at: null,
    next_run_at: soon,
    last_status: null,
    last_error: null,
    prune_targets: null,
    target_services: null,
    prune_label_filter: null,
    next_runs: [soon],
    ...overrides,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('MobileSchedules', () => {
  it('renders registry short labels for upcoming runs', async () => {
    mockedFetch.mockResolvedValue(jsonResponse([
      makeTask({ id: 1, action: 'auto_backup' }),
      makeTask({ id: 2, action: 'auto_down', next_runs: [Date.now() + 7_200_000] }),
    ]));

    const { container } = render(<MobileSchedules headerActions={null} />);

    expect(await screen.findByText('backup')).toBeInTheDocument();
    expect(await screen.findByText('down')).toBeInTheDocument();
    // auto_down carries the destructive tone in the registry; its StateDot
    // renders with the destructive class only if the tone is wired through.
    expect(container.querySelector('.bg-destructive')).toBeTruthy();
  });
});
