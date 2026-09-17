import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Blueprint, UpdateBlueprintInput } from '@/lib/blueprintsApi';

let lastEditorOptions: { readOnly?: boolean } | undefined;

vi.mock('@/lib/monacoLoader', () => ({
  Editor: ({
    options,
    onChange,
  }: {
    options?: { readOnly?: boolean };
    onChange?: (value: string | undefined) => void;
  }) => {
    lastEditorOptions = options;
    return (
      <div data-testid="monaco-editor">
        <button type="button" data-testid="monaco-edit-trigger" onClick={() => onChange?.('evil compose')}>
          edit
        </button>
      </div>
    );
  },
}));

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return {
    ...actual,
    analyzeCompose: vi.fn(),
    getContentBinding: vi.fn(),
  };
});

vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: [] }) }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { analyzeCompose, getContentBinding } from '@/lib/blueprintsApi';
import { BlueprintEditor } from './BlueprintEditor';

const inlineBlueprint: Blueprint = {
  id: 1,
  name: 'web-blueprint',
  description: null,
  compose_content: 'services:\n  web:\n    image: nginx\n',
  selector: { type: 'labels', any: ['prod'], all: [] },
  drift_mode: 'suggest',
  classification: 'stateless',
  classification_reasons: [],
  enabled: true,
  revision: 1,
  created_at: 0,
  updated_at: 0,
  created_by: 'admin',
  pinned_node_id: null,
  content_origin: 'inline',
  application_id: null,
};

const gitBlueprint: Blueprint = {
  ...inlineBlueprint,
  content_origin: 'git',
  application_id: 'app-web',
};

beforeEach(() => {
  lastEditorOptions = undefined;
  vi.mocked(analyzeCompose).mockResolvedValue({
    classification: 'stateless',
    reasons: [],
    hasNamedVolumes: false,
    hasBindMounts: false,
    hasExternalVolumes: false,
    hasTmpfsOnly: false,
  });
  vi.mocked(getContentBinding).mockResolvedValue({
    contentOrigin: 'git',
    applicationId: 'app-web',
    repoUrl: 'https://github.com/example/web.git',
    ref: 'main',
    composePaths: ['compose.yaml'],
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
    blockedRollout: true,
    snapshotPresent: true,
  });
});

describe('BlueprintEditor Git-managed compose', () => {
  it('omits compose_content and keeps the editor read-only', async () => {
    const onSubmit = vi.fn<(input: UpdateBlueprintInput) => Promise<void>>(async () => {});
    render(
      <BlueprintEditor
        mode="edit"
        initial={gitBlueprint}
        distinctLabels={['prod']}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );

    expect(await screen.findByText(/cannot deploy from the stored snapshot/i)).toBeInTheDocument();
    expect(lastEditorOptions?.readOnly).toBe(true);
    fireEvent.click(screen.getByTestId('monaco-edit-trigger'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).not.toHaveProperty('compose_content');
  });

  it('still sends compose_content for Inline edits', async () => {
    const onSubmit = vi.fn<(input: UpdateBlueprintInput) => Promise<void>>(async () => {});
    render(
      <BlueprintEditor
        mode="edit"
        initial={inlineBlueprint}
        distinctLabels={['prod']}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );

    expect(await screen.findByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(lastEditorOptions?.readOnly).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ compose_content: inlineBlueprint.compose_content });
  });
});
