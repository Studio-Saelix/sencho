import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/ui/modal', () => ({
  ConfirmModal: ({ open, title, children, confirmLabel, kicker }: {
    open: boolean; title: string; children: React.ReactNode; confirmLabel: React.ReactNode; kicker: string;
  }) => open ? (
    <div>
      <span>{kicker}</span>
      <h2>{title}</h2>
      {children}
      <button type="button">{confirmLabel}</button>
    </div>
  ) : null,
}));

import { LocalUpdateConfirmDialog } from '../LocalUpdateConfirmDialog';

describe('LocalUpdateConfirmDialog', () => {
  it('explains semver repinning when compose and target refs are known', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        imagePinKind="semver"
        composeImageRef="saelix/sencho:0.93.3"
        targetImageRef="saelix/sencho:0.94.0"
        targetVersion="0.94.0"
      />,
    );
    expect(screen.getByText(/rewrites it to/i)).toBeInTheDocument();
    expect(screen.getByText('saelix/sencho:0.93.3')).toBeInTheDocument();
    expect(screen.getByText('saelix/sencho:0.94.0')).toBeInTheDocument();
  });

  it('uses the generic pull copy for a floating tag', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        imagePinKind="floating"
        targetVersion="0.94.0"
      />,
    );
    expect(screen.getByText(/Pulls Sencho v0\.94\.0/i)).toBeInTheDocument();
    expect(screen.queryByText(/rewrites it to/i)).not.toBeInTheDocument();
  });

  it('explains a dev-image update with the dev kicker and no-repin, unsigned-image copy', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        isDevImage
        imagePinKind="floating"
        composeImageRef="ghcr.io/studio-saelix/sencho-dev:dev"
        targetVersion="0.99.0"
      />,
    );
    expect(screen.getByText('LOCAL · DEV UPDATE')).toBeInTheDocument();
    expect(screen.getByText(/ghcr\.io\/studio-saelix\/sencho-dev:dev/)).toBeInTheDocument();
    expect(screen.getByText(/image reference is not rewritten/i)).toBeInTheDocument();
    expect(screen.getByText(/unsigned/i)).toBeInTheDocument();
  });

  it('keeps the reapply kicker and copy for a dev image in reapply mode', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        mode="reapply"
        nodeType="local"
        isDevImage
      />,
    );
    expect(screen.getByText('LOCAL · REAPPLY')).toBeInTheDocument();
    expect(screen.queryByText('LOCAL · DEV UPDATE')).not.toBeInTheDocument();
    expect(screen.getByText(/current Compose configuration/i)).toBeInTheDocument();
  });

  it('uses the generic update copy and kicker when isDevImage is absent', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        imagePinKind="semver"
        composeImageRef="saelix/sencho:0.93.3"
        targetImageRef="saelix/sencho:0.94.0"
        targetVersion="0.94.0"
      />,
    );
    expect(screen.getByText('LOCAL · UPDATE')).toBeInTheDocument();
    expect(screen.queryByText('LOCAL · DEV UPDATE')).not.toBeInTheDocument();
  });

  it('explains local reapply without a version change or image rewrite', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        mode="reapply"
        nodeType="local"
      />,
    );
    expect(screen.getByRole('heading', { name: /Reapply configuration/i })).toBeInTheDocument();
    expect(screen.getByText(/current Compose configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/No newer Sencho version is selected/i)).toBeInTheDocument();
    expect(screen.getByText(/will not rewrite the configured image reference/i)).toBeInTheDocument();
    expect(screen.getByText(/briefly disconnect/i)).toBeInTheDocument();
  });

  it('explains remote reapply with REMOTE kicker and restart acknowledgement', () => {
    render(
      <LocalUpdateConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        mode="reapply"
        nodeType="remote"
      />,
    );
    expect(screen.getByRole('heading', { name: /Reapply configuration/i })).toBeInTheDocument();
    expect(screen.getByText(/Recreates this remote Sencho service/i)).toBeInTheDocument();
    expect(screen.getByText(/No newer Sencho version is selected/i)).toBeInTheDocument();
    expect(screen.getByText(/will not rewrite the configured image reference/i)).toBeInTheDocument();
    expect(screen.getByText(/The node will restart/i)).toBeInTheDocument();
  });
});
