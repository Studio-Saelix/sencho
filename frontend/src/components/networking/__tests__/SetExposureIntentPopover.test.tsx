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

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([
      { service: '', intent: 'lan' },
      { service: 'app', intent: 'internal' },
    ], expect.any(Number)));
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

  it('opens from a caller\'s own trigger and shows the footer under the picker', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [] }));
    render(
      <SetExposureIntentPopover
        stack="web"
        service="app"
        nodeId={2}
        onSaved={vi.fn()}
        trigger={<button type="button">Network exposed</button>}
        footer={<span>Open stack networking</span>}
      />,
    );
    expect(screen.queryByTestId(/^finding-verb-/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Network exposed' }));
    expect(await screen.findByRole('button', { name: 'lan' })).toBeInTheDocument();
    expect(screen.getByText('Open stack networking')).toBeInTheDocument();
  });

  it('numbers a save when its request starts, so a reply that lands late still reads as the earlier one', async () => {
    let releaseFirst!: () => void;
    const firstPut = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(json({ intents: [{ service: 'a', intent: 'lan' }] }));
    });
    api.apiFetch.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(json({ intents: [] }));
      const { service } = JSON.parse(init.body as string) as { service: string };
      return service === 'a' ? firstPut : Promise.resolve(json({ intents: [{ service: 'b', intent: 'lan' }] }));
    });
    const onSaved = vi.fn();
    render(
      <>
        <SetExposureIntentPopover stack="web" service="a" nodeId={2} onSaved={onSaved} trigger={<button type="button">first</button>} />
        <SetExposureIntentPopover stack="web" service="b" nodeId={2} onSaved={onSaved} trigger={<button type="button">second</button>} />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'first' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'second' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    releaseFirst();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));

    const [secondOrder, firstOrder] = onSaved.mock.calls.map((call) => call[1] as number);
    expect(firstOrder).toBeLessThan(secondOrder!);
  });
});
