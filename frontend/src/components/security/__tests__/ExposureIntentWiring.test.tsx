/**
 * Setting an exposure intent from the Images tab reaches the owner of the scan
 * summaries (so the label and its evidence line re-read), on the desktop table,
 * the phone row and the targeting banner, and a click inside the popover never
 * falls through to the row beneath it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImagesTab } from '../ImagesTab';
import { ImageScanRow } from '../SecurityMobile';
import type { ImageExposureContext, ScanSummary } from '@/types/security';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: toasts.error, info: vi.fn() } }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

const context: ImageExposureContext = {
  stackName: 'web', serviceName: 'api', exposureReason: 'published-port', intentStatus: 'unset',
};

function summary(): ScanSummary {
  return {
    image_ref: 'exp:1', scan_id: 1, highest_severity: null, scanned_at: Date.now(), total: 0,
    critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0, secret_count: 0, misconfig_count: 0,
    publicly_exposed: true, exposure_contexts: [context],
  };
}

const base = {
  loading: false,
  error: false,
  canScan: false,
  scanningRef: null as string | null,
  onScan: vi.fn(),
  nodeId: 3,
};

beforeEach(() => {
  toasts.error.mockReset();
  api.apiFetch.mockReset();
  api.apiFetch.mockResolvedValueOnce(json({ intents: [] }));
});

async function pickLan() {
  await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
}

/** The Images tab arrived at from a public-exposure reason whose one target is `exposed`. */
function renderTargeted(exposed: ImageExposureContext, label: string, onIntentSaved: () => void) {
  render(
    <ImagesTab
      {...base}
      onInspect={vi.fn()}
      onClearTargeting={vi.fn()}
      onIntentSaved={onIntentSaved}
      targeting={{
        kind: 'public_exposure',
        label,
        imageRefs: ['exp:1'],
        targets: [{ imageRef: 'exp:1', ...exposed }],
        token: 1,
      }}
      summaries={{ 'exp:1': { ...summary(), exposure_contexts: [exposed] } }}
    />,
  );
}

describe('onIntentSaved wiring', () => {
  it('reports a save made from the desktop table label', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'api', intent: 'lan' }] }));
    const onIntentSaved = vi.fn();
    render(<ImagesTab {...base} onInspect={vi.fn()} onIntentSaved={onIntentSaved} summaries={{ 'exp:1': summary() }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));
    await pickLan();

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledWith(
      'web',
      [{ service: 'api', intent: 'lan' }],
      expect.objectContaining({
        imageRef: 'exp:1',
        context: expect.objectContaining({ stackName: 'web', serviceName: 'api' }),
      }),
    ));
  });

  it('reports a save made from the conflict banner action', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'api', intent: 'lan' }] }));
    const onIntentSaved = vi.fn();
    const conflict = { ...context, intentStatus: 'set' as const, exposureIntent: 'internal' as const, intentConflict: true };
    renderTargeted(conflict, 'Exposure conflicts with declared intent', onIntentSaved);

    await userEvent.click(screen.getAllByRole('button', { name: 'Change intent' })[0]!);
    await pickLan();

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledWith(
      'web',
      [{ service: 'api', intent: 'lan' }],
      expect.objectContaining({
        imageRef: 'exp:1',
        context: expect.objectContaining({ stackName: 'web', serviceName: 'api' }),
      }),
    ));
  });

  it('reports a save made from the intentional banner action', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'api', intent: 'public' }] }));
    const onIntentSaved = vi.fn();
    const classified = { ...context, intentStatus: 'set' as const, exposureIntent: 'public' as const };
    renderTargeted(classified, 'Exposure', onIntentSaved);
    expect(screen.getByText('Exposure is intentional')).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Change intent' })[0]!);
    await pickLan();

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledWith(
      'web',
      [{ service: 'api', intent: 'public' }],
      expect.objectContaining({
        imageRef: 'exp:1',
        context: expect.objectContaining({ stackName: 'web', serviceName: 'api' }),
      }),
    ));
  });

  it('reports a save made from a row of the multi-context list', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'worker', intent: 'lan' }] }));
    const onIntentSaved = vi.fn();
    const other: ImageExposureContext = { stackName: 'jobs', serviceName: 'worker', exposureReason: 'published-port', intentStatus: 'unset' };
    render(<ImageScanRow summary={summary()} onInspect={vi.fn()} exposureContexts={[context, other]} nodeId={3} onIntentSaved={onIntentSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: choose a service' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Set intent for jobs/worker' }));
    await pickLan();

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledWith(
      'jobs',
      [{ service: 'worker', intent: 'lan' }],
      expect.objectContaining({
        imageRef: 'exp:1',
        context: expect.objectContaining({ stackName: 'jobs', serviceName: 'worker' }),
      }),
    ));
    const [path] = api.apiFetch.mock.calls[1] as [string];
    expect(path).toBe('/stacks/jobs/exposure');
  });

  it('reports a save made from the phone row without opening the scan', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'api', intent: 'lan' }] }));
    const onInspect = vi.fn();
    const onIntentSaved = vi.fn();
    render(
      <ImageScanRow summary={summary()} onInspect={onInspect} exposureContexts={[context]} nodeId={3} onIntentSaved={onIntentSaved} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));
    await pickLan();

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledWith(
      'web',
      [{ service: 'api', intent: 'lan' }],
      expect.objectContaining({
        imageRef: 'exp:1',
        context: expect.objectContaining({ stackName: 'web', serviceName: 'api' }),
      }),
    ));
    expect(onInspect).not.toHaveBeenCalled();
  });
});

describe('a refused save', () => {
  it('does not report the save and keeps the picker open', async () => {
    api.apiFetch.mockResolvedValueOnce(json({ error: 'nope' }, false));
    const onIntentSaved = vi.fn();
    render(<ImageScanRow summary={summary()} onInspect={vi.fn()} exposureContexts={[context]} nodeId={3} onIntentSaved={onIntentSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));
    await pickLan();

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('nope'));
    expect(onIntentSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'lan' })).toBeInTheDocument();
  });

  it('shows no picker when the intents could not be read', async () => {
    api.apiFetch.mockReset();
    api.apiFetch.mockResolvedValueOnce(json({ error: 'down' }, false));
    render(<ImageScanRow summary={summary()} onInspect={vi.fn()} exposureContexts={[context]} nodeId={3} onIntentSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('down'));
    expect(screen.queryByRole('button', { name: 'lan' })).toBeNull();
  });
});
