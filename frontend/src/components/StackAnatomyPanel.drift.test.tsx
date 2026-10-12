/**
 * The Drift tab is only useful if the host's handlers reach it: dropping one
 * prop would quietly remove its Redeploy, editor or Git source verb.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => null, text: async () => '' }) as unknown as Response) }));
vi.mock('./stack/StackActivityTimeline', () => ({ StackActivityTimeline: () => <div /> }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 }, hasCapability: () => false }) }));

const driftProps = vi.fn();
vi.mock('./stack/DriftPanel', () => ({
  default: (props: Record<string, unknown>) => {
    driftProps(props);
    return <div data-testid="drift-panel-stub" />;
  },
}));

import StackAnatomyPanel from './StackAnatomyPanel';

describe('StackAnatomyPanel Drift tab wiring', () => {
  it('hands the redeploy, editor and Git source handlers to the Drift panel', async () => {
    const onRedeploy = vi.fn();
    const onEditCompose = vi.fn();
    const onOpenGitSource = vi.fn();
    render(
      <StackAnatomyPanel
        stackName="web"
        content={'services:\n  web:\n    image: nginx:1.25\n'}
        envContent=""
        selectedEnvFile=".env"
        gitSourcePending={null}
        onEditCompose={onEditCompose}
        onOpenGitSource={onOpenGitSource}
        onRedeploy={onRedeploy}
        onApplyUpdate={vi.fn()}
        canEdit
        requestedTab="drift"
      />,
    );
    await screen.findByTestId('drift-panel-stub');
    expect(driftProps).toHaveBeenCalledWith(expect.objectContaining({ stackName: 'web', onRedeploy, onEditCompose, onOpenGitSource }));
  });
});
