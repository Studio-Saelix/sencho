import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BindingPreview, BlueprintPreview } from '@/lib/blueprintsApi';
import { BindingPreviewPanel } from './BindingPreviewPanel';

const blueprintPreview: BlueprintPreview = {
  blueprintId: 1,
  classification: 'stateless',
  matchedNodes: [{ id: 1, name: 'edge-1', type: 'local' }],
  plannedDeployments: [],
  plannedDriftChecks: [],
  plannedEvictions: [],
  name: 'edge',
  revision: 1,
  updatedAt: 0,
  driftMode: 'observe',
  stackName: 'edge',
  approvalStatus: 'pending',
  effectiveApproval: 'pending',
  planFingerprint: 'fp',
  generatedAt: 0,
  summary: { safe: 1, warning: 0, blocker: 0, total: 1 },
  changes: [{
    nodeId: 1,
    nodeName: 'edge-1',
    nodeType: 'local',
    mode: null,
    status: 'online',
    contactAt: null,
    contactSource: 'local',
    action: 'create',
    severity: 'safe',
    kind: 'executor',
    detail: 'Deploy the Blueprint stack on this node',
    reachabilityNote: 'Local node',
  }],
  confirmableActions: [],
  executorActions: [],
  unauthorizedActions: [],
  requirements: { variables: [], envFiles: [], composeSecrets: [] },
  compatibilityWarnings: [],
  healthNote: '',
  blockers: [],
  warnings: [],
};

const preview: BindingPreview = {
  transition: 'convert',
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
  blueprintPreview,
  markers: [{
    nodeId: 1,
    nodeName: 'edge-1',
    classification: 'conflicting',
  }],
  rollbackLimitations: ['Git-managed Blueprints cannot deploy from the stored snapshot.'],
};

describe('BindingPreviewPanel', () => {
  it('renders conflicting marker warnings before confirm', () => {
    render(<BindingPreviewPanel preview={preview} />);
    expect(screen.getByText('edge-1')).toBeInTheDocument();
    expect(screen.getByText('Marker belongs to another Blueprint')).toBeInTheDocument();
    expect(screen.getByText(/another Blueprint marker/i)).toBeInTheDocument();
    expect(screen.getByText('https://github.com/example/web.git · main')).toBeInTheDocument();
  });
});
