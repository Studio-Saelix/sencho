import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BindingPreview, BlueprintListItem } from '@/lib/blueprintsApi';
import { absentRevision } from '@/__tests__/gitopsFixtures';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return {
    ...actual,
    listBlueprints: vi.fn(),
    previewAdoptBlueprint: vi.fn(),
    adoptBlueprintFromStack: vi.fn(),
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import {
  adoptBlueprintFromStack,
  listBlueprints,
  previewAdoptBlueprint,
} from '@/lib/blueprintsApi';
import { AdoptBlueprintDialog } from './AdoptBlueprintDialog';

const blueprint: BlueprintListItem = {
  id: 7,
  name: 'edge',
  description: null,
  compose_content: 'services: {}',
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
  gitopsRevision: absentRevision(),
  deploymentCounts: {},
  deploymentTotal: 0,
};

const preview: BindingPreview = {
  transition: 'adopt',
  currentOrigin: 'inline',
  proposedOrigin: 'git',
  application: {
    id: 'app-web',
    stackName: 'web',
    repoUrl: 'https://github.com/example/web.git',
    ref: 'main',
    composePaths: ['compose.yaml'],
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
  },
  blueprintPreview: null,
  markers: [],
  rollbackLimitations: ['Adoption moves this live Git source onto the Blueprint. Credentials stay with that source.'],
};

beforeEach(() => {
  vi.mocked(listBlueprints).mockResolvedValue([
    blueprint,
    { ...blueprint, id: 8, name: 'git-edge', content_origin: 'git', application_id: 'app-other' },
  ]);
  vi.mocked(previewAdoptBlueprint).mockResolvedValue(preview);
  vi.mocked(adoptBlueprintFromStack).mockResolvedValue({
    contentOrigin: 'git',
    applicationId: 'app-web',
    repoUrl: preview.application.repoUrl,
    ref: preview.application.ref,
    composePaths: preview.application.composePaths,
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
    blockedRollout: true,
    snapshotPresent: true,
  });
});

describe('AdoptBlueprintDialog', () => {
  it('previews then adopts onto the selected Inline Blueprint', async () => {
    const onAdopted = vi.fn();
    render(
      <AdoptBlueprintDialog open onOpenChange={vi.fn()} stackName="web" onAdopted={onAdopted} />,
    );

    await screen.findByText('Blueprint');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('git-edge');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    await screen.findByText('Adoption moves this live Git source onto the Blueprint. Credentials stay with that source.');
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => {
      expect(adoptBlueprintFromStack).toHaveBeenCalledWith('web', 7);
      expect(onAdopted).toHaveBeenCalled();
    });
  });
});
