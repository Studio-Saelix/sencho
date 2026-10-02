import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GitOpsGitSourceHost } from './GitOpsGitSourceHost';
import { GITOPS_GIT_SOURCE_EVENT, type GitOpsGitSourceTarget } from './portfolioNavigation';

const can = vi.fn((action: string, _type?: string, _id?: string, nodeId?: number | null) => action === 'stack:edit' && nodeId === 2);

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can }) }));
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@/components/stack/GitSourcePanel', () => ({
  GitSourcePanel: (props: { open: boolean; onOpenChange: (open: boolean) => void; onSourceChanged: () => void; stackName: string; nodeId: number; crumb: string[]; showPortfolioLink: boolean; canEdit: boolean; canDeploy: boolean }) => (
    <div data-testid="panel" data-open={String(props.open)}>
      <button type="button" onClick={() => props.onOpenChange(false)}>close</button>
      <button type="button" onClick={props.onSourceChanged}>changed</button>
      <span data-testid="full">{JSON.stringify({
        stackName: props.stackName,
        nodeId: props.nodeId,
        crumb: props.crumb,
        showPortfolioLink: props.showPortfolioLink,
        canEdit: props.canEdit,
        canDeploy: props.canDeploy,
      })}</span>
      <span data-testid="props">{JSON.stringify({ stackName: props.stackName, nodeId: props.nodeId })}</span>
    </div>
  ),
}));

function request(detail: GitOpsGitSourceTarget) {
  act(() => {
    window.dispatchEvent(new CustomEvent<GitOpsGitSourceTarget>(GITOPS_GIT_SOURCE_EVENT, { detail }));
  });
}

describe('GitOpsGitSourceHost', () => {
  it('renders nothing until a Git source is requested', () => {
    render(<GitOpsGitSourceHost />);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('opens the requested application\'s sheet on its own node, with that node\'s permissions', () => {
    render(<GitOpsGitSourceHost />);
    request({ nodeId: 2, stackName: 'bookstack', applicationName: 'bookstack' });

    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(JSON.parse(screen.getByTestId('full').textContent ?? '')).toEqual({
      stackName: 'bookstack',
      nodeId: 2,
      crumb: ['GitOps', 'bookstack', 'Git source'],
      showPortfolioLink: false,
      canEdit: true,
      canDeploy: false,
    });
  });

  it('reopens for the next application after a close, on that application\'s node', () => {
    render(<GitOpsGitSourceHost />);
    request({ nodeId: 2, stackName: 'bookstack', applicationName: 'bookstack' });
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-open', 'false');

    request({ nodeId: 5, stackName: 'wiki', applicationName: 'wiki' });
    expect(screen.getByTestId('panel')).toHaveAttribute('data-open', 'true');
    expect(JSON.parse(screen.getByTestId('props').textContent ?? '')).toEqual({ stackName: 'wiki', nodeId: 5 });
  });

  it('raises the shared refresh signal when the sheet changes the source', () => {
    const invalidated = vi.fn();
    window.addEventListener('sencho:state-invalidate', invalidated);
    render(<GitOpsGitSourceHost />);
    request({ nodeId: 2, stackName: 'bookstack', applicationName: 'bookstack' });
    fireEvent.click(screen.getByRole('button', { name: 'changed' }));
    expect(invalidated).toHaveBeenCalledTimes(1);
    window.removeEventListener('sencho:state-invalidate', invalidated);
  });
});
