import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Blueprint, CreateBlueprintInput, UpdateBlueprintInput } from '@/lib/blueprintsApi';

let lastEditorOptions: { readOnly?: boolean } | undefined;
let nextEditValue = 'evil compose';

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
        <button type="button" data-testid="monaco-edit-trigger" onClick={() => onChange?.(nextEditValue)}>
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

const nodeList = [
  { id: 1, name: 'alpha', type: 'local' },
  { id: 2, name: 'beta', type: 'remote' },
];
const grants = { manageNode: true, allowedNodes: null as Set<string> | null };

vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: nodeList }) }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    can: (action: string, _type?: string, id?: string) => action !== 'node:manage'
      || (grants.manageNode && (grants.allowedNodes === null || grants.allowedNodes.has(String(id)))),
  }),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { analyzeCompose, getContentBinding } from '@/lib/blueprintsApi';
import { BlueprintEditor, type BlueprintSubmitOptions } from './BlueprintEditor';

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
  nextEditValue = 'evil compose';
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
        nodeLabels={{ 1: ['prod'] }}
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
        nodeLabels={{ 1: ['prod'] }}
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

describe('BlueprintEditor targets', () => {
  type Submit = (input: CreateBlueprintInput | UpdateBlueprintInput, options: BlueprintSubmitOptions) => Promise<void>;

  function renderCreate(overrides: { canReview?: boolean } = {}) {
    const onSubmit = vi.fn<Submit>(async () => {});
    render(
      <BlueprintEditor
        mode="create"
        nodeLabels={{ 1: ['prod'], 2: [] }}
        canReview={overrides.canReview ?? true}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('caddy-edge'), { target: { value: 'web-edge' } });
    return onSubmit;
  }

  async function stageLabel(user: ReturnType<typeof userEvent.setup>, label: string, nodeName: string) {
    await user.click(screen.getByRole('button', { name: /^label$/i }));
    await user.type(await screen.findByLabelText('Label'), label);
    await user.click(screen.getByRole('checkbox', { name: new RegExp(nodeName) }));
    await user.click(screen.getByRole('button', { name: 'Add label' }));
  }

  it('lists the nodes the selected label reaches', async () => {
    renderCreate();
    expect(screen.getByText('Matches no nodes yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(screen.getByText('Matches 1 node')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('stages a new label on a node and counts it toward the match before anything is written', async () => {
    const user = userEvent.setup();
    renderCreate();
    await stageLabel(user, 'edge', 'beta');
    expect(screen.getByText('Matches 1 node')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText(/edge on beta/)).toBeInTheDocument();
  });

  it('hands staged labels to the review action and drops them on a draft', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await stageLabel(user, 'edge', 'beta');

    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toEqual({ intent: 'save', staged: [] });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selector: { type: 'labels', any: ['edge'], all: [] } });

    await user.click(screen.getByRole('button', { name: 'Review rollout' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][1]).toEqual({ intent: 'review', staged: [{ nodeId: 2, label: 'edge' }] });
  });

  it('writes no staged labels once the selector stops using them', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await stageLabel(user, 'edge', 'beta');
    fireEvent.click(screen.getByRole('radio', { name: /specific nodes/i }));
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await user.click(screen.getByRole('button', { name: 'Review rollout' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toEqual({ intent: 'review', staged: [] });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selector: { type: 'nodes', ids: [1] } });
  });

  it('removes a staged tag and the label it introduced', async () => {
    const user = userEvent.setup();
    renderCreate();
    await stageLabel(user, 'edge', 'beta');
    await user.click(screen.getByRole('button', { name: 'Remove tag edge from beta' }));
    expect(screen.getByText('Matches no nodes yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edge' })).toBeNull();
  });

  it('offers one create action when a rollout cannot be reviewed', () => {
    renderCreate({ canReview: false });
    expect(screen.queryByRole('button', { name: 'Review rollout' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create blueprint' })).toBeInTheDocument();
  });

  it('offers only the nodes the operator may label', async () => {
    const user = userEvent.setup();
    grants.allowedNodes = new Set(['1']);
    try {
      renderCreate();
      await user.click(screen.getByRole('button', { name: /^label$/i }));
      expect(await screen.findByRole('checkbox', { name: /alpha/ })).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /beta/ })).toBeNull();
    } finally {
      grants.allowedNodes = null;
    }
  });

  it('commits staged labels through the single create action when the reconciler is off', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await stageLabel(user, 'edge', 'beta');
    await user.click(screen.getByRole('switch', { name: /reconciler enabled/i }));
    expect(screen.queryByRole('button', { name: 'Review rollout' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create blueprint' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toEqual({ intent: 'save', staged: [{ nodeId: 2, label: 'edge' }] });
  });

  it('selects Match all and submits the labels as an all list', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await user.click(screen.getByRole('button', { name: 'prod' }));
    await user.click(screen.getByRole('radio', { name: /match all/i }));
    await user.click(screen.getByRole('button', { name: 'Review rollout' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selector: { type: 'labels', any: [], all: ['prod'] } });
  });

  it('hides the label control from an operator who cannot manage nodes', () => {
    grants.manageNode = false;
    try {
      renderCreate();
      expect(screen.queryByRole('button', { name: /^label$/i })).toBeNull();
    } finally {
      grants.manageNode = true;
    }
  });

  it('refuses to continue without a target', async () => {
    const onSubmit = renderCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Review rollout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one label');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a selector that uses both lists intact on edit', async () => {
    const onSubmit = vi.fn<Submit>(async () => {});
    render(
      <BlueprintEditor
        mode="edit"
        initial={{ ...inlineBlueprint, selector: { type: 'labels', any: ['prod'], all: ['edge'] } }}
        nodeLabels={{ 1: ['prod', 'edge'] }}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selector: { type: 'labels', any: ['prod'], all: ['edge'] } });
  });
});

describe('BlueprintEditor form feedback', () => {
  type Submit = (input: CreateBlueprintInput | UpdateBlueprintInput, options: BlueprintSubmitOptions) => Promise<void>;

  function renderCreate(canReview = true) {
    const onSubmit = vi.fn<Submit>(async () => {});
    render(
      <BlueprintEditor mode="create" nodeLabels={{ 1: ['prod'], 2: ['prod'] }} canReview={canReview} onCancel={vi.fn()} onSubmit={onSubmit} submitting={false} />,
    );
    return onSubmit;
  }

  it('flags a missing name beside the field and clears it once typed', async () => {
    const onSubmit = renderCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Review rollout' }));
    expect(await screen.findByText('Give the Blueprint a name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('caddy-edge')).toHaveFocus();
    expect(screen.getByText('Pick at least one label')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('caddy-edge')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByPlaceholderText('caddy-edge'), { target: { value: 'web' } });
    expect(screen.queryByText('Give the Blueprint a name')).toBeNull();
    expect(screen.getByText('Pick at least one label')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a name the server would refuse, inline', async () => {
    renderCreate();
    fireEvent.change(screen.getByPlaceholderText('caddy-edge'), { target: { value: 'Web Edge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review rollout' }));
    expect(await screen.findByText(/lowercase letters, digits, hyphens or underscores/)).toBeInTheDocument();
  });

  it('says what the primary action will do to node labels', async () => {
    const user = userEvent.setup();
    renderCreate();
    expect(screen.getByText('Nothing deploys until you confirm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^label$/i }));
    await user.type(await screen.findByLabelText('Label'), 'edge');
    await user.click(screen.getByRole('checkbox', { name: /beta/ }));
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    expect(screen.getByText('Review adds 1 node label. A draft does not')).toBeInTheDocument();
  });

  it('turns the reconciler off with a switch and explains the consequence', () => {
    renderCreate();
    const toggle = screen.getByRole('switch', { name: /reconciler enabled/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/never deployed or repaired/)).toBeInTheDocument();
  });

  it('shows when the compose could not be analyzed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(analyzeCompose).mockRejectedValue(new Error('offline'));
    renderCreate();
    expect(await screen.findByText('Could not analyze', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('shows one stateful warning, not three', async () => {
    vi.mocked(analyzeCompose).mockResolvedValue({
      classification: 'stateful', reasons: [], hasNamedVolumes: true, hasBindMounts: false, hasExternalVolumes: false, hasTmpfsOnly: false,
    });
    renderCreate();
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(await screen.findByText(/stateful and targets more than one node/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/Stateful blueprints require explicit confirmation/)).toBeNull();
  });

  it('flags an empty compose beside the editor and clears it on edit', async () => {
    const onSubmit = renderCreate();
    fireEvent.change(screen.getByPlaceholderText('caddy-edge'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    nextEditValue = '';
    fireEvent.click(screen.getByTestId('monaco-edit-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Review rollout' }));
    expect(await screen.findByText('Compose content cannot be empty')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('caddy-edge')).not.toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    nextEditValue = 'services: {}';
    fireEvent.click(screen.getByTestId('monaco-edit-trigger'));
    expect(screen.queryByText('Compose content cannot be empty')).toBeNull();
  });

  it('clears the target error as soon as a label is chosen', async () => {
    renderCreate();
    fireEvent.change(screen.getByPlaceholderText('caddy-edge'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review rollout' }));
    expect(await screen.findByText('Pick at least one label')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(screen.queryByText('Pick at least one label')).toBeNull();
  });

  it('cancels from the create footer', () => {
    const onCancel = vi.fn();
    render(
      <BlueprintEditor mode="create" nodeLabels={{}} canReview onCancel={onCancel} onSubmit={vi.fn()} submitting={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hints the label write on the single create action when no rollout can be reviewed', async () => {
    const user = userEvent.setup();
    renderCreate(false);
    await user.click(screen.getByRole('button', { name: /^label$/i }));
    await user.type(await screen.findByLabelText('Label'), 'edge');
    await user.click(screen.getByRole('checkbox', { name: /beta/ }));
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    expect(screen.getByText('Adds 1 node label')).toBeInTheDocument();
  });

  it('keeps edit actions inline with no draft or review action, and hints staged labels on save', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <BlueprintEditor mode="edit" initial={inlineBlueprint} nodeLabels={{ 1: ['prod'], 2: [] }} canReview onCancel={onCancel} onSubmit={vi.fn()} submitting={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review rollout' })).toBeNull();
    expect(screen.queryByText(/on save/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^label$/i }));
    await user.type(await screen.findByLabelText('Label'), 'edge');
    await user.click(screen.getByRole('checkbox', { name: /beta/ }));
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    expect(screen.getByText('Adds 1 node label on save')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not warn about multiple nodes when the selector reaches one', async () => {
    vi.mocked(analyzeCompose).mockResolvedValue({
      classification: 'stateful', reasons: [], hasNamedVolumes: true, hasBindMounts: false, hasExternalVolumes: false, hasTmpfsOnly: false,
    });
    render(
      <BlueprintEditor mode="create" nodeLabels={{ 1: ['prod'], 2: [] }} canReview onCancel={vi.fn()} onSubmit={vi.fn()} submitting={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'prod' }));
    expect(await screen.findByText(/Persistent volumes detected/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/stateful and targets more than one node/)).toBeNull();
  });

  it('drops the analysis failure notice once a later analysis succeeds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(analyzeCompose).mockRejectedValueOnce(new Error('offline'));
    renderCreate();
    expect(await screen.findByText('Could not analyze', undefined, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('monaco-edit-trigger'));
    await waitFor(() => expect(screen.queryByText('Could not analyze')).toBeNull(), { timeout: 3000 });
    spy.mockRestore();
  });
});
