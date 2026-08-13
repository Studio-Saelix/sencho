import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComposeDiffPreviewDialog } from '../ComposeDiffPreviewDialog';
import { resolveComposeDiffActionLabel } from '../resolveComposeDiffActionLabel';

vi.mock('@/lib/SafeDiffEditor', () => ({
  SafeDiffEditor: () => <div data-testid="diff-editor" />,
}));

describe('resolveComposeDiffActionLabel', () => {
  it('returns Save for save-only mode', () => {
    expect(resolveComposeDiffActionLabel('save', false)).toBe('Save');
    expect(resolveComposeDiffActionLabel('save', true)).toBe('Save');
  });

  it('returns Save when mode is undefined', () => {
    expect(resolveComposeDiffActionLabel(undefined, true)).toBe('Save');
  });

  it('returns Save & deploy for ordinary save-and-deploy', () => {
    expect(resolveComposeDiffActionLabel('save-and-deploy', false)).toBe('Save & deploy');
  });

  it('returns Save & reapply when self-stack reapply is eligible', () => {
    expect(resolveComposeDiffActionLabel('save-and-deploy', true)).toBe('Save & reapply');
  });
});

describe('ComposeDiffPreviewDialog', () => {
  it('renders the Save & reapply confirm CTA', () => {
    render(
      <ComposeDiffPreviewDialog
        open
        onOpenChange={vi.fn()}
        stackName="sencho"
        fileName="docker-compose.yml"
        language="yaml"
        original="a"
        modified="b"
        actionLabel="Save & reapply"
        confirming={false}
        isDarkMode={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save & reapply' })).toBeInTheDocument();
  });

  it('unmounts the diff editor without throwing', () => {
    const { unmount } = render(
      <ComposeDiffPreviewDialog
        open
        onOpenChange={vi.fn()}
        stackName="sencho"
        fileName="docker-compose.yml"
        language="yaml"
        original="a"
        modified="b"
        actionLabel="Save"
        confirming={false}
        isDarkMode={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('diff-editor')).toBeInTheDocument();
    expect(() => unmount()).not.toThrow();
  });
});
