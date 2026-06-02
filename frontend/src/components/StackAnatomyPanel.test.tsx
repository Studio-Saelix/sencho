/**
 * Covers the "Update available" banner lifecycle: the apply button must reflect
 * the in-flight update (disabled + progress label), and the banner must clear
 * itself once the update lands (re-checking the preview) while staying put if
 * the update did not take effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('./stack/StackActivityTimeline', () => ({
  StackActivityTimeline: () => <div data-testid="activity-timeline" />,
}));

import { apiFetch } from '@/lib/api';
import StackAnatomyPanel from './StackAnatomyPanel';

const COMPOSE = 'services:\n  web:\n    image: nginx:1.25\n';

function previewBody(hasUpdate: boolean) {
  return {
    summary: {
      has_update: hasUpdate,
      primary_image: 'nginx',
      current_tag: '1.25',
      next_tag: '1.26',
      semver_bump: 'minor',
      blocked: false,
      blocked_reason: null,
    },
    changelog: null,
  };
}

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: async () => body, text: async () => '' } as unknown as Response;
}

let hasUpdate = true;

const updatePreviewCalls = () =>
  vi.mocked(apiFetch).mock.calls.filter(([input]) => String(input).includes('/update-preview')).length;

beforeEach(() => {
  hasUpdate = true;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/update-preview')) return jsonRes(previewBody(hasUpdate));
    if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
    return jsonRes(null, false); // git-source and anything else: nothing to show
  });
});

function panel(applying: boolean, onApplyUpdate: () => void = vi.fn(), stackName = 'web') {
  return (
    <StackAnatomyPanel
      stackName={stackName}
      content={COMPOSE}
      envContent=""
      selectedEnvFile=".env"
      gitSourcePending={false}
      onEditCompose={vi.fn()}
      onOpenGitSource={vi.fn()}
      onApplyUpdate={onApplyUpdate}
      canEdit
      applying={applying}
    />
  );
}

describe('StackAnatomyPanel update banner', () => {
  it('shows the apply button and fires onApplyUpdate when clicked', async () => {
    const onApply = vi.fn();
    render(panel(false, onApply));

    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('disables the apply button and shows progress while applying', async () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    rerender(panel(true, onApply));

    const btn = screen.getByRole('button', { name: /applying/i });
    expect(btn).toBeDisabled();
  });

  it('clears the banner after the update lands', async () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    rerender(panel(true, onApply)); // update in flight
    hasUpdate = false; // backend now reports the stack is current
    rerender(panel(false, onApply)); // apply finished

    await waitFor(() =>
      expect(screen.queryByTestId('update-available-banner')).not.toBeInTheDocument(),
    );
  });

  it('keeps the banner if the update did not take effect', async () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    const before = updatePreviewCalls();
    rerender(panel(true, onApply));
    rerender(panel(false, onApply)); // hasUpdate stays true: still an update pending

    await waitFor(() => expect(updatePreviewCalls()).toBeGreaterThan(before));
    expect(screen.getByTestId('update-available-banner')).toBeInTheDocument();
  });

  it('does not re-check the preview while applying stays false', async () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    const before = updatePreviewCalls();
    rerender(panel(false, onApply));
    rerender(panel(false, onApply));
    await Promise.resolve();

    expect(updatePreviewCalls()).toBe(before); // re-check fires only on the true -> false edge
  });

  it('does not fire onApplyUpdate while the apply button is disabled', async () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    rerender(panel(true, onApply));
    fireEvent.click(screen.getByRole('button', { name: /applying/i }));

    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps the banner when the post-apply re-check returns a non-OK response', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let updateCalls = 0;
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        updateCalls += 1;
        return updateCalls >= 2 ? jsonRes(null, false) : jsonRes(previewBody(true));
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });

    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    const before = updatePreviewCalls();
    rerender(panel(true, onApply));
    rerender(panel(false, onApply)); // re-check returns not-ok: keep the known banner

    await waitFor(() => expect(updatePreviewCalls()).toBeGreaterThan(before));
    expect(screen.getByTestId('update-available-banner')).toBeInTheDocument();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('keeps the banner when the post-apply re-check throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let updateCalls = 0;
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        updateCalls += 1;
        if (updateCalls >= 2) throw new Error('network down');
        return jsonRes(previewBody(true));
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });

    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply));
    await screen.findByTestId('update-available-banner');

    const before = updatePreviewCalls();
    rerender(panel(true, onApply));
    rerender(panel(false, onApply)); // re-check throws: keep the known banner

    await waitFor(() => expect(updatePreviewCalls()).toBeGreaterThan(before));
    expect(screen.getByTestId('update-available-banner')).toBeInTheDocument();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does not re-check after switching stacks while the first is still applying', async () => {
    const calls: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        calls.push(url);
        return jsonRes(previewBody(!url.includes('/stacks/other/'))); // web has an update, other does not
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    const otherCalls = () => calls.filter((u) => u.includes('/stacks/other/update-preview')).length;

    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply, 'web'));
    await screen.findByTestId('update-available-banner');

    rerender(panel(true, onApply, 'web')); // web applying
    rerender(panel(false, onApply, 'other')); // switch stacks before web's apply finishes

    await waitFor(() => expect(otherCalls()).toBe(1)); // only the stack-change mount fetch
    await Promise.resolve();
    expect(otherCalls()).toBe(1); // the apply-completion re-check must not fire for "other"
  });

  it('ignores a stale re-check that resolves after the stack changed', async () => {
    let resolveStale!: (r: Response) => void;
    const stale = new Promise<Response>((r) => { resolveStale = r; });
    const webResponses: Response[] = [jsonRes(previewBody(true))]; // mount: web has an update
    vi.mocked(apiFetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/stacks/web/update-preview')) {
        const next = webResponses.shift();
        return next ? Promise.resolve(next) : stale; // post-apply re-check for web hangs
      }
      if (url.includes('/stacks/other/update-preview')) return Promise.resolve(jsonRes(previewBody(false)));
      if (url.includes('/scan-status')) return Promise.resolve(jsonRes({ status: 'ok' }));
      return Promise.resolve(jsonRes(null, false));
    });

    const onApply = vi.fn();
    const { rerender } = render(panel(false, onApply, 'web'));
    await screen.findByTestId('update-available-banner');

    rerender(panel(true, onApply, 'web'));
    rerender(panel(false, onApply, 'web')); // re-check fires and hangs
    rerender(panel(false, onApply, 'other')); // switch stacks: cleanup cancels the hung re-check

    await waitFor(() =>
      expect(screen.queryByTestId('update-available-banner')).not.toBeInTheDocument(),
    );

    resolveStale(jsonRes(previewBody(true))); // late stale result for web must be dropped
    await Promise.resolve();

    expect(screen.queryByTestId('update-available-banner')).not.toBeInTheDocument();
  });
});
