import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateStackDialog } from '../CreateStackDialog';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: 1, name: 'local' } }),
}));

describe('CreateStackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderOpen(overrides: Partial<ComponentProps<typeof CreateStackDialog>> = {}) {
    return render(
      <CreateStackDialog
        open
        onOpenChange={vi.fn()}
        onStackCreated={vi.fn()}
        onStacksChanged={vi.fn()}
        {...overrides}
      />,
    );
  }

  it('renders exactly three evenly sized source tabs (no Import)', () => {
    renderOpen();

    const tablist = screen.getByRole('tablist', { name: 'Stack source' });
    expect(tablist.className).toContain('grid-cols-3');

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.textContent)).toEqual(
      expect.arrayContaining(['Empty', 'From Git', 'From Docker Run']),
    );
    expect(tabs.some((t) => /import/i.test(t.textContent ?? ''))).toBe(false);
  });

  it('exposes adopt footer link when onOpenAdopt is provided', () => {
    const onOpenAdopt = vi.fn();
    const onOpenChange = vi.fn();
    renderOpen({ onOpenAdopt, onOpenChange });

    fireEvent.click(screen.getByRole('button', { name: /adopt existing files instead/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenAdopt).toHaveBeenCalledTimes(1);
  });

  it('hides adopt footer when onOpenAdopt is omitted', () => {
    renderOpen();
    expect(screen.queryByRole('button', { name: /adopt existing files instead/i })).toBeNull();
  });

  it('rolls back an orphaned stack with pruneVolumes=true when saving converted YAML fails', async () => {
    const fetchMock = vi.mocked(apiFetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ yaml: 'services:\n  app:\n    image: nginx' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // POST /stacks create
      .mockResolvedValueOnce(new Response('save failed', { status: 500 })) // PUT save
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // DELETE rollback

    renderOpen();
    fireEvent.click(screen.getByRole('tab', { name: 'From Docker Run' }));

    fireEvent.change(screen.getByLabelText('Paste your docker run command'), {
      target: { value: 'docker run -d --name nginx -p 8080:80 nginx:latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: /convert/i }));
    await waitFor(() => expect(screen.getByText('compose.yaml preview')).toBeVisible());

    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'nginx' } });
    fireEvent.click(screen.getByRole('button', { name: /create stack/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock).toHaveBeenLastCalledWith('/stacks/nginx?pruneVolumes=true', { method: 'DELETE' });
  });
});
