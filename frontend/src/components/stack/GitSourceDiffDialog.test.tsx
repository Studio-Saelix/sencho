/**
 * Classified Git change-plan review: operations render, Apply stays disabled
 * when blocked or the plan is missing, and Apply never posts source bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitSourceDiffDialog, type PullResult } from './GitSourceDiffDialog';

function emptyCounts() {
  return {
    add: 0, modify: 0, delete: 0, rename: 0, unchanged: 0,
    localModified: 0, localMissing: 0, typeChanged: 0, unmanagedCollision: 0, invocation: 0,
  };
}

function pull(over: Partial<PullResult> = {}): PullResult {
  return {
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    validation: { ok: true },
    plan: {
      blocked: false,
      counts: { ...emptyCounts(), modify: 1, unchanged: 3 },
      operations: [
        { path: 'compose.yaml', op: 'modify', role: 'compose-primary' },
      ],
      invocation: { candidateChanged: false, liveDiverged: false },
    },
    planFingerprint: 'fp-clean',
    ...over,
  };
}

function renderDialog(over: Partial<PullResult> = {}, onApply = vi.fn()) {
  render(
    <GitSourceDiffDialog
      open
      onOpenChange={vi.fn()}
      stackName="web"
      pull={pull(over)}
      autoDeployDefault={false}
      applying={false}
      onApply={onApply}
      onDismiss={vi.fn()}
    />,
  );
  return onApply;
}

describe('GitSourceDiffDialog', () => {
  it('lists classified operations and collapses unchanged files', () => {
    renderDialog();
    expect(screen.getByText('Modify')).toBeInTheDocument();
    expect(screen.getByText('compose.yaml')).toBeInTheDocument();
    expect(screen.getByText('3 unchanged files')).toBeInTheDocument();
    expect(screen.queryByText(/Monaco|Overwrite local edits/i)).not.toBeInTheDocument();
  });

  it('disables Apply when the plan is blocked', () => {
    renderDialog({
      plan: {
        blocked: true,
        counts: { ...emptyCounts(), localModified: 1 },
        operations: [{ path: 'compose.yaml', op: 'local-modified', role: 'compose-primary' }],
        invocation: { candidateChanged: false, liveDiverged: false },
      },
    });
    expect(screen.getByRole('button', { name: /^Apply$/ })).toBeDisabled();
    expect(screen.getAllByText(/Local conflicts block apply/i).length).toBeGreaterThan(0);
  });

  it('keeps Apply enabled for invocation drift and does not claim file conflicts', () => {
    const onApply = renderDialog({
      plan: {
        blocked: false,
        counts: { ...emptyCounts(), invocation: 1, modify: 1 },
        operations: [
          { path: 'compose.yaml', op: 'modify', role: 'compose-primary' },
          { path: null, op: 'invocation', role: 'invocation' },
        ],
        invocation: { candidateChanged: false, liveDiverged: true },
      },
      planFingerprint: 'fp-inv',
    });
    expect(screen.queryByText(/Local conflicts block apply/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Live Compose invocation changed/i)).toBeInTheDocument();
    expect(screen.getByText('Compose command line')).toBeInTheDocument();
    expect(screen.queryByText(/secret-bearing managed path/i)).not.toBeInTheDocument();
    const apply = screen.getByRole('button', { name: /^Apply$/ });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(
      'abcdef1234567890abcdef1234567890abcdef12',
      false,
      'fp-inv',
    );
  });

  it('disables Apply when the plan is missing', () => {
    renderDialog({ plan: null, planFingerprint: null });
    expect(screen.getByRole('button', { name: /^Apply$/ })).toBeDisabled();
    expect(screen.getByText(/Change plan unavailable/i)).toBeInTheDocument();
  });

  it('calls onApply with commitSha, deploy, and planFingerprint', () => {
    const onApply = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
    expect(onApply).toHaveBeenCalledWith(
      'abcdef1234567890abcdef1234567890abcdef12',
      false,
      'fp-clean',
    );
  });

  it('redacts a missing path as a secret-bearing managed path', () => {
    renderDialog({
      plan: {
        blocked: false,
        counts: { ...emptyCounts(), modify: 1 },
        operations: [{ path: null, op: 'modify', role: 'env' }],
        invocation: { candidateChanged: false, liveDiverged: false },
      },
    });
    expect(screen.getByText('secret-bearing managed path')).toBeInTheDocument();
  });
});
