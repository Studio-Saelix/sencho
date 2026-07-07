import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/ui/modal', () => ({
  ConfirmModal: ({ open, title, children, confirmLabel }: {
    open: boolean; title: string; children: React.ReactNode; confirmLabel: React.ReactNode;
  }) => open ? (
    <div>
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
});
