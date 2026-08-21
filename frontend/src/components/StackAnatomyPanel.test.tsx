/**
 * Covers the "Update available" banner lifecycle: the apply button must reflect
 * the in-flight update (disabled + progress label), and the banner must clear
 * itself once the update lands (re-checking the preview) while staying put if
 * the update did not take effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
import { SOURCE_STATE } from '@/lib/gitopsState';
import type { GitOpsSourceStatus } from '@/types/gitops';

const COMPOSE = 'services:\n  web:\n    image: nginx:1.25\n';

function previewBody(
  hasUpdate: boolean,
  buildServices: string[] = [],
  over: {
    verification_failed?: boolean;
    verification_error?: string | null;
    check_error?: string | null;
    blocked?: boolean;
    blocked_reason?: string | null;
  } = {},
) {
  const hasBuild = buildServices.length > 0;
  const verificationFailed = over.verification_failed ?? false;
  return {
    build_services: buildServices,
    images: [
      {
        service: 'web',
        image: 'nginx:1.25',
        current_tag: '1.25',
        next_tag: '1.25',
        has_update: hasUpdate,
        digest_update: hasUpdate,
        tag_update: false,
        semver_bump: hasUpdate ? 'patch' : 'none',
        check_status: verificationFailed ? 'failed' : 'ok',
        check_error: over.check_error ?? null,
      },
    ],
    summary: {
      has_update: hasUpdate,
      primary_image: 'nginx',
      current_tag: '1.25',
      next_tag: '1.25',
      semver_bump: hasUpdate ? 'patch' : 'none',
      update_kind: hasUpdate ? 'digest' : 'none',
      blocked: over.blocked ?? false,
      blocked_reason: over.blocked_reason ?? null,
      has_build_services: hasBuild,
      rebuild_available: hasBuild,
      check_status: verificationFailed ? 'failed' : 'ok',
      verification_failed: verificationFailed,
      verification_error: over.verification_error ?? null,
    },
    changelog: null,
  };
}

/** Two-service preview: `web` confirms a digest update, `db` fails digest verification. */
function mixedPreviewBody(over: { blocked?: boolean; blocked_reason?: string | null } = {}) {
  return {
    build_services: [],
    images: [
      {
        service: 'web', image: 'nginx:1.25', current_tag: '1.25', next_tag: '1.25',
        has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch',
        check_status: 'ok', check_error: null,
      },
      {
        service: 'db', image: 'private.example/db:latest', current_tag: 'latest', next_tag: null,
        has_update: false, digest_update: false, tag_update: false, semver_bump: 'none',
        check_status: 'failed', check_error: 'Registry unreachable', digest_error: 'Registry unreachable',
      },
    ],
    summary: {
      has_update: true,
      primary_image: 'nginx',
      current_tag: '1.25',
      next_tag: '1.25',
      semver_bump: 'patch',
      update_kind: 'digest',
      blocked: over.blocked ?? false,
      blocked_reason: over.blocked_reason ?? null,
      has_build_services: false,
      rebuild_available: false,
      check_status: 'partial',
      verification_failed: true,
      verification_error: 'Registry unreachable',
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
      gitSourcePending={null}
      onEditCompose={vi.fn()}
      onOpenGitSource={vi.fn()}
      onApplyUpdate={onApplyUpdate}
      canEdit
      applying={applying}
    />
  );
}

describe('StackAnatomyPanel edit affordance', () => {
  it('renders Edit compose with a stable test id when canEdit is true', () => {
    render(panel(false));
    expect(screen.getByTestId('anatomy-edit-compose-btn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit compose/i })).toBeInTheDocument();
  });

  it('hides Edit compose when canEdit is false', () => {
    render(
      <StackAnatomyPanel
        stackName="web"
        content={COMPOSE}
        envContent=""
        selectedEnvFile=".env"
        gitSourcePending={null}
        onEditCompose={vi.fn()}
        onOpenGitSource={vi.fn()}
        onApplyUpdate={vi.fn()}
        canEdit={false}
        applying={false}
      />,
    );
    expect(screen.queryByTestId('anatomy-edit-compose-btn')).not.toBeInTheDocument();
  });
});

describe('StackAnatomyPanel git source state', () => {
  function withPending(gitSourcePending: GitOpsSourceStatus | null) {
    return (
      <StackAnatomyPanel
        stackName="web"
        content={COMPOSE}
        envContent=""
        selectedEnvFile=".env"
        gitSourcePending={gitSourcePending}
        onEditCompose={vi.fn()}
        onOpenGitSource={vi.fn()}
        onApplyUpdate={vi.fn()}
        canEdit
        applying={false}
      />
    );
  }

  it('shows only the dot for an ordinary waiting update', () => {
    // The dot already means "an update is waiting", so naming that state would
    // be saying the same thing twice, and it is the common case.
    const { container } = render(withPending('candidate_ready'));
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText(SOURCE_STATE.candidate_ready.label)).not.toBeInTheDocument();
  });

  it('names a state the dot cannot express', () => {
    render(withPending('source_conflict_blocker'));
    expect(screen.getByText(SOURCE_STATE.source_conflict_blocker.label)).toBeInTheDocument();
  });

  it('shows neither when nothing is waiting', () => {
    const { container } = render(withPending(null));
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});

describe('StackAnatomyPanel update banner', () => {
  it('hides apply when only a newer tag is available', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        return jsonRes({
          build_services: [],
          images: [{
            service: 'web', image: 'nginx:1.25', current_tag: '1.25', next_tag: '1.26',
            has_update: true, digest_update: false, tag_update: true, semver_bump: 'minor', check_status: 'ok',
          }],
          summary: {
            has_update: true, primary_image: 'nginx', current_tag: '1.25', next_tag: '1.26',
            semver_bump: 'minor', update_kind: 'tag', blocked: false, blocked_reason: null,
            has_build_services: false, rebuild_available: false, check_status: 'ok',
          },
          changelog: null,
        });
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    await waitFor(() => expect(screen.getByTestId('update-available-banner')).toBeInTheDocument());
    expect(screen.getByText((t) => typeof t === 'string' && t.includes('newer tag') && t.includes('edit Compose pin'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'apply' })).not.toBeInTheDocument();
  });

  it('shows the apply button and fires onApplyUpdate when clicked', async () => {
    const onApply = vi.fn();
    render(panel(false, onApply));

    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.getByText('nginx')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('names each updated image on multi-service stacks', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        return jsonRes({
          build_services: [],
          images: [
            { service: 'web', image: 'nginx:1.25', current_tag: '1.25', next_tag: '1.25', has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch', check_status: 'ok' },
            { service: 'cache', image: 'redis:7.2', current_tag: '7.2', next_tag: '7.2', has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch', check_status: 'ok' },
            { service: 'db', image: 'postgres:16', current_tag: '16', next_tag: null, has_update: false, digest_update: false, tag_update: false, semver_bump: 'none', check_status: 'ok' },
          ],
          summary: {
            has_update: true,
            primary_image: 'nginx:1.25',
            current_tag: '1.25',
            next_tag: '1.26',
            semver_bump: 'minor',
            update_kind: 'tag',
            blocked: false,
            blocked_reason: null,
            has_build_services: false,
            rebuild_available: false,
          },
          changelog: null,
        });
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });

    render(panel(false));

    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.getByText('nginx')).toBeInTheDocument();
    expect(screen.getByText('redis')).toBeInTheDocument();
    expect(screen.queryByText('postgres')).not.toBeInTheDocument();
  });

  it('shows Rebuild & Update for build-only stacks', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(false, ['app']));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });

    render(panel(false));

    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.getByText(/Rebuild available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebuild & Update' })).toBeInTheDocument();
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
        gitSourcePending={null}
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
        gitSourcePending={null}
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

describe('StackAnatomyPanel digest verification failure', () => {
  it('shows an update-check-status banner instead of an update claim when digest check errors', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        return jsonRes(previewBody(false, [], {
          verification_failed: true,
          verification_error: 'Registry unreachable',
          check_error: 'Registry unreachable',
        }));
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    expect(await screen.findByTestId('update-check-status-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('update-available-banner')).toBeNull();
    expect(screen.getByText(/Registry unreachable/)).toBeInTheDocument();
  });

  it('does not claim "safe to apply" and withholds the full-stack Apply button when a confirmed update sits alongside a DIFFERENT image failing verification', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(mixedPreviewBody());
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    // A confirmed update alongside a different image's failure renders only
    // the update banner (mutually exclusive with the check-status banner);
    // the review-required hold is inline in that banner's lead-in text.
    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('update-check-status-banner')).toBeNull();
    expect(screen.getByText(/review required/i)).toBeInTheDocument();
    expect(screen.queryByText(/safe to apply/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^apply$/i })).toBeNull();
  });

  it('keeps a single image with a confirmed digest update fully actionable when there is no digest error anywhere in the stack', async () => {
    // digest_update and digest_error are mutually exclusive for one image (both
    // derive from the same comparison), so a confirmed digest update is always
    // its own clean case, with nothing to hold it for review.
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) return jsonRes(previewBody(true));
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.getByText(/same-tag digest rebuild/i)).toBeInTheDocument();
    expect(screen.queryByText(/review required/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^apply$/i })).toBeEnabled();
    const hint = screen.getByTestId('digest-rebuild-hint');
    expect(hint).toHaveTextContent(/same-tag digest rebuild/i);
    await act(async () => { fireEvent.click(hint); });
    expect(await screen.findByTestId('digest-rebuild-hint-content')).toHaveTextContent(/same tag, newer content/i);
  });

  it('holds a confirmed update for review even when the other image\'s own tag update masks its digest error into an overall ok check_status', async () => {
    // The db image's tag compare confirmed an update, so the backend masks its
    // digest failure into check_status 'ok' + check_error null. Only the
    // unmasked digest_error still reports that its content went unverified.
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        return jsonRes({
          build_services: [],
          images: [
            {
              service: 'web', image: 'nginx:1.25', current_tag: '1.25', next_tag: '1.25',
              has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch',
              check_status: 'ok', check_error: null, digest_error: null,
            },
            {
              service: 'db', image: 'private.example/db:latest', current_tag: '2.0', next_tag: '2.1',
              has_update: true, digest_update: false, tag_update: true, semver_bump: 'minor',
              check_status: 'ok', check_error: null, digest_error: 'Registry unreachable',
            },
          ],
          summary: {
            has_update: true, primary_image: 'nginx', current_tag: '1.25', next_tag: '1.25',
            semver_bump: 'patch', update_kind: 'digest', blocked: false, blocked_reason: null,
            has_build_services: false, rebuild_available: false,
            check_status: 'ok', verification_failed: false, verification_error: null,
          },
          changelog: null,
        });
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    expect(await screen.findByTestId('update-available-banner')).toBeInTheDocument();
    expect(screen.getByText(/review required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^apply$/i })).toBeNull();
  });

  it('keeps the blocked (major-bump policy) banner precedence over the verification-failure review-required banner', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/update-preview')) {
        return jsonRes(mixedPreviewBody({ blocked: true, blocked_reason: 'Major version bump' }));
      }
      if (url.includes('/scan-status')) return jsonRes({ status: 'ok' });
      return jsonRes(null, false);
    });
    render(panel(false));
    expect(await screen.findByText(/review required/i)).toBeInTheDocument();
    expect(screen.getByText(/Major version bump/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^apply$/i })).toBeNull();
  });
});
