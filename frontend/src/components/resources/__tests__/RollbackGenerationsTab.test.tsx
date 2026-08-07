import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RollbackGenerationsTab, type RollbackGeneration } from '../RollbackGenerationsTab';
import { toast } from '@/components/ui/toast-store';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

function generation(overrides: Partial<RollbackGeneration> = {}): RollbackGeneration {
  return {
    id: 'gen-1',
    shortId: 'abc123456789',
    stackName: 'seerr',
    status: 'superseded',
    isCurrent: false,
    phase: 'immediate_verified',
    createdAt: Date.now(),
    artifactExpiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
    releasable: true,
    ...overrides,
  };
}

function stackNamesInOrder(): string[] {
  return screen.getAllByRole('row').slice(1).map((row) => {
    const cells = within(row).getAllByRole('cell');
    return cells[0]?.textContent ?? '';
  });
}

function shortIdsInOrder(): string[] {
  return screen.getAllByRole('row').slice(1).map((row) => {
    const cells = within(row).getAllByRole('cell');
    return cells[1]?.textContent ?? '';
  });
}

function stateLabelsInOrder(): string[] {
  return screen.getAllByRole('row').slice(1).map((row) => {
    const cells = within(row).getAllByRole('cell');
    return cells[2]?.textContent ?? '';
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
});

describe('RollbackGenerationsTab', () => {
  it('shows superseded-generation confirm copy (not the current-generation warning) for a non-current release', async () => {
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation({ isCurrent: false })]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));

    expect(await screen.findByText(/Permanently removes the held rollback image/i)).toBeInTheDocument();
    expect(screen.queryByText(/Automatic rollback is unavailable until/i)).not.toBeInTheDocument();
  });

  it('shows the current-generation warning copy when releasing the current generation', async () => {
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation({ isCurrent: true, status: 'active' })]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));

    expect(await screen.findByText(/Sencho will not be able to automatically/i)).toBeInTheDocument();
  });

  it('confirming release POSTs to the release endpoint and calls onReleased on success', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, message: 'Rollback protection released', artifactsCleaned: true }) });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/system/rollback/generations/gen-1/release', { method: 'POST' }));
    await waitFor(() => expect(onReleased).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Rollback protection released');
  });

  it('surfaces the backend partial-cleanup message distinctly from a full release', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'Rollback protection released; cleanup will finish shortly', artifactsCleaned: false }),
    });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rollback protection released; cleanup will finish shortly'));
  });

  it('surfaces the server error via toast and closes the modal without a lingering Releasing state on failure', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'This rollback generation cannot be released right now (it may be observing a health gate, mid-recovery, or already in progress).', code: 'NOT_ELIGIBLE' }) });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('cannot be released right now')));
    expect(onReleased).not.toHaveBeenCalled();
    // Modal closes (confirm button no longer present) rather than staying stuck mid-action.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument());
  });

  it('hides the Release action for a non-admin', () => {
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin={false} onReleased={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /release rollback protection/i })).not.toBeInTheDocument();
  });

  it('disables the Release action when the generation is not releasable', () => {
    render(<RollbackGenerationsTab generations={[generation({ releasable: false })]} isLoading={false} isAdmin onReleased={vi.fn()} />);
    expect(screen.getByRole('button', { name: /release rollback protection/i })).toBeDisabled();
  });

  it('renders an empty state when there are no generations', () => {
    render(<RollbackGenerationsTab generations={[]} isLoading={false} isAdmin onReleased={vi.fn()} />);
    expect(screen.getByText(/No rollback-protected generations on this node/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton instead of the empty state while the initial fetch is in flight', () => {
    render(<RollbackGenerationsTab generations={[]} isLoading={true} isAdmin onReleased={vi.fn()} />);
    expect(screen.queryByText(/No rollback-protected generations on this node/i)).not.toBeInTheDocument();
  });

  describe('search and sort', () => {
    const newestFirst = [
      generation({ id: 'gen-new', shortId: 'newaaaaaaaaa', stackName: 'Zebra', status: 'active', isCurrent: true, createdAt: 3000, artifactExpiresAt: null }),
      generation({ id: 'gen-mid', shortId: 'midbbbbbbbbb', stackName: 'alpha', status: 'recovery_required', isCurrent: true, createdAt: 2000, artifactExpiresAt: null }),
      generation({ id: 'gen-old', shortId: 'oldccccccccc', stackName: 'bravo', status: 'superseded', isCurrent: false, createdAt: 1000, artifactExpiresAt: 5000 }),
    ];

    it('defaults to newest-first generation order', () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      expect(shortIdsInOrder()).toEqual(['newaaaaaaaaa', 'midbbbbbbbbb', 'oldccccccccc']);
    });

    it('reverses to oldest-first when Generation is clicked', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /^Generation/i }));
      expect(shortIdsInOrder()).toEqual(['oldccccccccc', 'midbbbbbbbbb', 'newaaaaaaaaa']);
    });

    it('sorts Stack ascending then descending', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /^Stack/i }));
      expect(stackNamesInOrder()).toEqual(['alpha', 'bravo', 'Zebra']);
      await userEvent.click(screen.getByRole('button', { name: /^Stack/i }));
      expect(stackNamesInOrder()).toEqual(['Zebra', 'bravo', 'alpha']);
    });

    it('sorts State by displayed values including current recovery_required', async () => {
      const rows = [
        generation({ id: 'g-sup', shortId: 'sup111111111', stackName: 's1', status: 'superseded', isCurrent: false, createdAt: 1, artifactExpiresAt: 100 }),
        generation({ id: 'g-rec', shortId: 'rec222222222', stackName: 's2', status: 'recovery_required', isCurrent: true, createdAt: 2, artifactExpiresAt: null }),
        generation({ id: 'g-cur', shortId: 'cur333333333', stackName: 's3', status: 'active', isCurrent: true, createdAt: 3, artifactExpiresAt: null }),
      ];
      render(<RollbackGenerationsTab generations={rows} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /^State/i }));
      expect(stateLabelsInOrder()).toEqual(['Current', 'Recovery required', 'Superseded']);
      await userEvent.click(screen.getByRole('button', { name: /^State/i }));
      expect(stateLabelsInOrder()).toEqual(['Superseded', 'Recovery required', 'Current']);
    });

    it('sorts Retention with dated expiries before undated on ascending, reverse on descending', async () => {
      const rows = [
        generation({ id: 'g-null', shortId: 'nul111111111', stackName: 'n', status: 'active', isCurrent: true, createdAt: 3, artifactExpiresAt: null }),
        generation({ id: 'g-late', shortId: 'lat222222222', stackName: 'l', status: 'superseded', isCurrent: false, createdAt: 2, artifactExpiresAt: 9000 }),
        generation({ id: 'g-early', shortId: 'ear333333333', stackName: 'e', status: 'superseded', isCurrent: false, createdAt: 1, artifactExpiresAt: 1000 }),
      ];
      render(<RollbackGenerationsTab generations={rows} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /^Retention/i }));
      expect(shortIdsInOrder()).toEqual(['ear333333333', 'lat222222222', 'nul111111111']);
      await userEvent.click(screen.getByRole('button', { name: /^Retention/i }));
      expect(shortIdsInOrder()).toEqual(['nul111111111', 'lat222222222', 'ear333333333']);
    });

    it('filters by case-insensitive stack name', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /search rollback generations/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /search rollback generations/i }), 'ALPHA');
      expect(stackNamesInOrder()).toEqual(['alpha']);
    });

    it('filters by short generation id', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /search rollback generations/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /search rollback generations/i }), 'oldccc');
      expect(shortIdsInOrder()).toEqual(['oldccccccccc']);
    });

    it('expands search on click, keeps input open with a query, and collapses on empty blur', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      const expand = screen.getByRole('button', { name: /search rollback generations/i });
      expect(expand.className).toMatch(/max-md:min-h-11/);
      expect(expand.className).toMatch(/max-md:min-w-11/);
      await userEvent.click(expand);
      const input = screen.getByRole('textbox', { name: /search rollback generations/i });
      expect(input).toHaveFocus();
      expect(input.className).toMatch(/max-md:min-h-11/);
      await userEvent.type(input, 'z');
      await userEvent.tab();
      expect(screen.getByRole('textbox', { name: /search rollback generations/i })).toBeInTheDocument();
      await userEvent.clear(screen.getByRole('textbox', { name: /search rollback generations/i }));
      await userEvent.tab();
      expect(screen.queryByRole('textbox', { name: /search rollback generations/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /search rollback generations/i })).toBeInTheDocument();
    });

    it('shows filtered-empty copy when search matches nothing', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /search rollback generations/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /search rollback generations/i }), 'no-such-stack');
      expect(screen.getByText(/No generations match this filter/i)).toBeInTheDocument();
      expect(screen.queryByText(/No rollback-protected generations on this node/i)).not.toBeInTheDocument();
    });

    it('filters Current (including recovery_required) and Superseded by displayed state', async () => {
      const rows = [
        generation({ id: 'g-cur', shortId: 'cur111111111', stackName: 'curr', status: 'active', isCurrent: true, createdAt: 3 }),
        generation({ id: 'g-rec', shortId: 'rec222222222', stackName: 'recv', status: 'recovery_required', isCurrent: true, createdAt: 2, artifactExpiresAt: null }),
        generation({ id: 'g-sup', shortId: 'sup333333333', stackName: 'supe', status: 'superseded', isCurrent: false, createdAt: 1 }),
      ];
      render(<RollbackGenerationsTab generations={rows} isLoading={false} isAdmin onReleased={vi.fn()} />);
      expect(screen.getByRole('button', { name: /^All/i })).toHaveTextContent('3');
      expect(screen.getByRole('button', { name: /^Current/i })).toHaveTextContent('2');
      expect(screen.getByRole('button', { name: /^Superseded/i })).toHaveTextContent('1');

      await userEvent.click(screen.getByRole('button', { name: /^Current/i }));
      expect(stackNamesInOrder()).toEqual(['curr', 'recv']);

      await userEvent.click(screen.getByRole('button', { name: /^Superseded/i }));
      expect(stackNamesInOrder()).toEqual(['supe']);

      await userEvent.click(screen.getByRole('button', { name: /^All/i }));
      expect(stackNamesInOrder()).toEqual(['curr', 'recv', 'supe']);
    });

    it('applies mobile touch-target classes on sortable header wrappers', () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      const stackHead = screen.getByRole('button', { name: /^Stack/i }).closest('th');
      expect(stackHead?.className).toMatch(/max-md:\[&_button\]:min-h-11/);
    });

    it('puts the help copy behind an info tooltip instead of a body paragraph', async () => {
      render(<RollbackGenerationsTab generations={newestFirst} isLoading={false} isAdmin onReleased={vi.fn()} />);
      expect(screen.queryByText(/Rollback-protected images from full-stack updates/i)).not.toBeInTheDocument();
      await userEvent.hover(screen.getByRole('button', { name: /about rollback generations/i }));
      expect(await screen.findByText(/Rollback-protected images from full-stack updates/i)).toBeInTheDocument();
      expect(screen.getByText(/Deploy Guardrails/i)).toBeInTheDocument();
    });
  });
});
