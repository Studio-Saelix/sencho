import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, nodeMeta, copy, toastSpy } = vi.hoisted(() => ({
  auth: { canEdit: true },
  nodeMeta: new Map<number, { capabilities: string[] }>(),
  copy: vi.fn(),
  toastSpy: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => auth.canEdit }) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodeMeta }) }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copy }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastSpy }));

import { UpdateServiceNotes } from '../UpdateServiceNotes';

const digest = `sha256:${'c'.repeat(64)}`;

function preview(images: Record<string, unknown>[], hasUpdate = true) {
  return {
    images: images.map(over => ({
      service: 'web', image: 'web:1.0.0', current_tag: '1.0.0', next_tag: null, has_update: true,
      digest_update: false, tag_update: false, semver_bump: 'patch' as const, ...over,
    })),
    summary: {
      has_update: hasUpdate, primary_image: 'web:1.0.0', current_tag: '1.0.0', next_tag: null,
      semver_bump: 'patch' as const, blocked: false, blocked_reason: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.canEdit = true;
  nodeMeta.clear();
  nodeMeta.set(1, { capabilities: ['sencho-label-detection-v1'] });
  copy.mockResolvedValue(undefined);
});

describe('UpdateServiceNotes', () => {
  it('copies the exact skip line for a rebuild and says where it goes', async () => {
    render(<UpdateServiceNotes preview={preview([{ digest_update: true, next_tag: '1.0.0', candidate_digest: digest }])} stack="site" nodeId={1} variant="list" />);
    await act(async () => { fireEvent.click(screen.getByTestId('update-copy-skip-label')); });
    expect(copy).toHaveBeenCalledWith(`io.sencho.update.ignore: "${digest}"`);
    expect(toastSpy.success).toHaveBeenCalledWith(expect.stringContaining('under the web service\'s labels'));
    expect(toastSpy.success).toHaveBeenCalledWith(expect.stringContaining('Recheck'));
  });

  it('copies the newer tag for a tag update, and both when both are pending', async () => {
    const { rerender } = render(
      <UpdateServiceNotes preview={preview([{ tag_update: true, next_tag: '1.1.0' }])} stack="site" nodeId={1} variant="list" />,
    );
    await act(async () => { fireEvent.click(screen.getByTestId('update-copy-skip-label')); });
    expect(copy).toHaveBeenLastCalledWith('io.sencho.update.ignore: "1.1.0"');
    rerender(
      <UpdateServiceNotes
        preview={preview([{ tag_update: true, digest_update: true, next_tag: '1.1.0', candidate_digest: digest }])}
        stack="site" nodeId={1} variant="list"
      />,
    );
    await act(async () => { fireEvent.click(screen.getByTestId('update-copy-skip-label')); });
    expect(copy).toHaveBeenLastCalledWith(`io.sencho.update.ignore: "1.1.0,${digest}"`);
  });

  it('leaves the verb out, not disabled, when the candidate is unknown, the node cannot evaluate it, or the user cannot edit', () => {
    const unknown = preview([{ digest_update: true, next_tag: '1.0.0', candidate_digest: null }]);
    const known = preview([{ tag_update: true, next_tag: '1.1.0' }]);
    const { rerender } = render(<UpdateServiceNotes preview={unknown} stack="site" nodeId={1} variant="list" />);
    expect(screen.queryByTestId('update-copy-skip-label')).toBeNull();

    nodeMeta.set(1, { capabilities: [] });
    rerender(<UpdateServiceNotes preview={known} stack="site" nodeId={1} variant="list" />);
    expect(screen.queryByTestId('update-copy-skip-label')).toBeNull();

    nodeMeta.set(1, { capabilities: ['sencho-label-detection-v1'] });
    auth.canEdit = false;
    rerender(<UpdateServiceNotes preview={{ ...known }} stack="site" nodeId={1} variant="list" />);
    expect(screen.queryByTestId('update-copy-skip-label')).toBeNull();
  });

  it('reports a clipboard failure through the error toast', async () => {
    copy.mockRejectedValue(new Error('blocked'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<UpdateServiceNotes preview={preview([{ tag_update: true, next_tag: '1.1.0' }])} stack="site" nodeId={1} variant="list" />);
    await act(async () => { fireEvent.click(screen.getByTestId('update-copy-skip-label')); });
    expect(toastSpy.error).toHaveBeenCalledWith(expect.stringContaining('Copy failed'));
    expect(toastSpy.success).not.toHaveBeenCalled();
  });

  it('shows the changelog link in a new tab without opener access', () => {
    render(
      <UpdateServiceNotes
        preview={preview([{ tag_update: true, next_tag: '1.1.0', changelog_url: 'https://github.com/example/web/releases' }])}
        stack="site" nodeId={1} variant="inline"
      />,
    );
    const link = screen.getByTestId('update-changelog-link');
    expect(link).toHaveAttribute('href', 'https://github.com/example/web/releases');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('names the services an update also pulls', () => {
    render(
      <UpdateServiceNotes
        preview={preview([
          { tag_update: true, next_tag: '1.1.0' },
          { service: 'worker', has_update: false, detection: 'ignored' },
          { service: 'db', has_update: false, check_status: 'not_checkable', detection: 'off' },
        ])}
        stack="site" nodeId={1} variant="list"
      />,
    );
    expect(screen.getByTestId('update-also-pulls')).toHaveTextContent('Applying also pulls: worker (update skipped), db (not checked)');
  });

  it('renders nothing without a link, a skip, or a service to name', () => {
    nodeMeta.clear();
    const { container } = render(
      <UpdateServiceNotes preview={preview([{ tag_update: true, next_tag: '1.1.0' }])} stack="site" nodeId={1} variant="list" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
