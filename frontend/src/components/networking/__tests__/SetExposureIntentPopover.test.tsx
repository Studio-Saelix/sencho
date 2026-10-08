import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetExposureIntentPopover } from '../SetExposureIntentPopover';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => {
  api.apiFetch.mockReset();
});

function renderPopover(onSaved = vi.fn()) {
  render(<SetExposureIntentPopover stack="web" service="app" nodeId={2} label="Set exposure intent" finding={{ id: 'f' }} onSaved={onSaved} />);
  return onSaved;
}

describe('SetExposureIntentPopover', () => {
  it('saves the chosen intent for the finding\'s service on the finding\'s node with the second click', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: '', intent: 'lan' }] }));
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: '', intent: 'lan' }, { service: 'app', intent: 'internal' }] }));
    const onSaved = renderPopover();

    await userEvent.click(screen.getByRole('button', { name: 'Set exposure intent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'internal' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [path, init] = api.apiFetch.mock.calls[1] as [string, RequestInit & { nodeId?: number }];
    expect(path).toBe('/stacks/web/exposure');
    expect(init.method).toBe('PUT');
    expect(init.nodeId).toBe(2);
    expect(JSON.parse(init.body as string)).toEqual({ service: 'app', intent: 'internal' });
  });

  it('shows the stack intent a service inherits', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: '', intent: 'public' }] }));
    renderPopover();
    await userEvent.click(screen.getByRole('button', { name: 'Set exposure intent' }));
    expect(await screen.findByText('→ public')).toBeInTheDocument();
  });

  it('keeps the finding listed when the save fails', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [] }));
    api.apiFetch.mockResolvedValueOnce(json({ error: 'nope' }, false));
    const onSaved = renderPopover();
    await userEvent.click(screen.getByRole('button', { name: 'Set exposure intent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(2));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
