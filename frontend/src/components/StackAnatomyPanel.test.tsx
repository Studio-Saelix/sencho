/**
 * Covers the "Update available" banner lifecycle: the apply button must reflect
 * the in-flight update (disabled + progress label), and the banner must clear
 * itself once the update lands (re-checking the preview) while staying put if
 * the update did not take effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('./stack/StackActivityTimeline', () => ({
  StackActivityTimeline: () => <div data-testid="activity-timeline" />,
}));
// This suite covers the update banner, not the Doctor tab; keep the capability
// off so the panel surface stays exactly what these tests assert against. The
// active node is mutable so the footer-link tests can simulate a remote node.
const { nodeState } = vi.hoisted(() => ({ nodeState: { activeNode: { id: 1 } as unknown } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: nodeState.activeNode, hasCapability: () => false }) }));

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
  nodeState.activeNode = { id: 1 };
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

  it('renders the git badge when a source is attached', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(false));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      if (url.includes('/git-source')) {
        return jsonRes({ repo_url: 'https://github.com/org/repo.git', branch: 'main', compose_path: 'compose.yaml' });
      }
      return jsonRes(null, false);
    });

    render(panel(false));

    // Positive control: a linked stack shows the "git · host/repo#branch" badge,
    // which proves the matcher used by the unlinked test below is real.
    await screen.findByText(/github\.com\/org\/repo#main/);
    expect(screen.queryByText('local')).not.toBeInTheDocument();
  });

  it('treats a 200 { linked: false } git-source response as unlinked', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(true));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      if (url.includes('/git-source')) return jsonRes({ linked: false }); // 200, no source attached
      return jsonRes(null, false);
    });

    render(panel(false));

    // The git-source effect runs before the banner effect, so by the time the
    // banner renders the git-source response has been applied. An unlinked
    // stack must keep the "local" label, not flip to a git badge.
    await screen.findByTestId('update-available-banner');
    expect(screen.getByText('local')).toBeInTheDocument();
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

describe('StackAnatomyPanel exposed footer', () => {
  function renderWithPorts(content: string) {
    return render(
      <StackAnatomyPanel
        stackName="web"
        content={content}
        envContent=""
        selectedEnvFile=".env"
        gitSourcePending={false}
        onEditCompose={vi.fn()}
        onOpenGitSource={vi.fn()}
        onApplyUpdate={vi.fn()}
        canEdit
        applying={false}
      />,
    );
  }

  it('renders the exposed port as a real link for a published port', async () => {
    renderWithPorts('services:\n  web:\n    image: x\n    ports:\n      - "8989:8989"\n');
    const link = await screen.findByRole('link', { name: /:8989/ });
    expect(link).toHaveAttribute('href', 'http://localhost:8989');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not render a link for a container-only port', async () => {
    renderWithPorts('services:\n  web:\n    image: x\n    ports:\n      - "80"\n');
    await screen.findByText('exposed');
    expect(screen.queryByRole('link', { name: /:\d+/ })).toBeNull();
  });

  it('shows the port as plain text (no link) on a remote node with no reachable host', async () => {
    nodeState.activeNode = { id: 9, type: 'remote', api_url: '' };
    renderWithPorts('services:\n  web:\n    image: x\n    ports:\n      - "8989:8989"\n');
    expect(await screen.findByText(/:8989/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /:8989/ })).toBeNull();
  });
});

describe('StackAnatomyPanel effective dossier (multi-file Git)', () => {
  const ROOT_NO_PORTS = 'services:\n  web:\n    image: nginx:1.25\n';

  function renderPanel(content = ROOT_NO_PORTS) {
    return render(
      <StackAnatomyPanel
        stackName="web"
        content={content}
        envContent=""
        selectedEnvFile=".env"
        gitSourcePending={false}
        onEditCompose={vi.fn()}
        onOpenGitSource={vi.fn()}
        onApplyUpdate={vi.fn()}
        canEdit
        applying={false}
      />,
    );
  }

  it('reads override-published ports from the effective model, so the dossier shows them and doc-drift does not false-warn', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(false));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      // Multi-file source: two configured compose paths.
      if (url.includes('/git-source')) return jsonRes({
        repo_url: 'https://github.com/org/repo.git', branch: 'main',
        compose_path: 'compose.yaml', compose_paths: ['compose.yaml', 'infra/override.yaml'],
      });
      // An override publishes :9000, absent from the root file above.
      if (url.includes('/effective-anatomy')) return jsonRes({
        renderable: true, services: ['web'],
        ports: { web: [{ host: '9000', container: '9000', proto: 'tcp', published: true }] },
        volumes: {}, restart: null, networks: ['default'],
      });
      // The operator documented the override's port.
      if (url.includes('/dossier')) return jsonRes({ access_urls: 'http://192.168.1.5:9000' });
      return jsonRes(null, false);
    });

    renderPanel();
    await userEvent.click(await screen.findByRole('tab', { name: 'Dossier' }));
    await screen.findByTestId('dossier-panel');

    // The generated-facts ports row counts the override-published port, proving the
    // dossier read the merged effective model rather than the port-less root file.
    // (Scoped to the SPAN so it does not also match the access_urls value below.)
    await screen.findByText((content, el) => el?.tagName === 'SPAN' && content.startsWith('1 published'));
    // And doc-drift stays silent: the documented :9000 is published in the effective
    // model, so a root-only parse would false-warn here but the effective view must not.
    await waitFor(() => expect(screen.queryByTestId('dossier-doc-drift')).not.toBeInTheDocument());
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/effective-anatomy'))).toBe(true);
  });

  it('does not fetch the effective model for a single-file Git stack', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(false));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      if (url.includes('/git-source')) return jsonRes({
        repo_url: 'https://github.com/org/repo.git', branch: 'main',
        compose_path: 'compose.yaml', compose_paths: ['compose.yaml'],
      });
      if (url.includes('/dossier')) return jsonRes({});
      return jsonRes(null, false);
    });

    renderPanel();
    await userEvent.click(await screen.findByRole('tab', { name: 'Dossier' }));
    await screen.findByText(/github\.com\/org\/repo#main/);
    // Give any (incorrect) effective fetch a chance to fire before asserting absence.
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/git-source'))).toBe(true));
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/effective-anatomy'))).toBe(false);
  });
});

describe('StackAnatomyPanel capability gating (capability off)', () => {
  it('hides the Networking, Doctor, and Storage tabs when the capabilities are absent', async () => {
    render(panel(false));
    // The always-on Anatomy tab confirms the panel mounted.
    expect(await screen.findByRole('tab', { name: 'Anatomy' })).toBeInTheDocument();
    expect(screen.queryByTestId('networking-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('doctor-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('storage-tab')).not.toBeInTheDocument();
  });
});
