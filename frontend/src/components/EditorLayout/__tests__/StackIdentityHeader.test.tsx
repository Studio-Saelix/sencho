import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { StackIdentityHeader } from '../editor-view-blocks';
import type { ContainerInfo } from '../EditorView';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../Terminal', () => ({ default: () => null }));
vi.mock('../../StructuredLogViewer', () => ({ default: () => null }));
vi.mock('../../ImageSourceMenu', () => ({ ImageSourceMenu: () => null }));

const CONTAINERS: ContainerInfo[] = [
  {
    Id: 'abc123',
    Names: ['/web'],
    State: 'running',
    Status: 'Up 2 hours',
    Image: 'nginx:alpine',
    ImageID: 'sha256:deadbeef',
    healthStatus: 'healthy',
  } as ContainerInfo,
  {
    Id: 'def456',
    Names: ['/api'],
    State: 'running',
    Status: 'Up 2 hours',
    Image: 'node:20',
    ImageID: 'sha256:cafebabe',
    healthStatus: 'healthy',
  } as ContainerInfo,
];

function renderHeader(over: Partial<ComponentProps<typeof StackIdentityHeader>> = {}) {
  return render(
    <StackIdentityHeader
      stackName="plex"
      activeNode={{ id: 1, name: 'local', type: 'local' } as never}
      safeContainers={CONTAINERS}
      isRunning
      can={() => true}
      trivy={{ available: false }}
      backupInfo={{ exists: false, timestamp: null }}
      loadingAction={null}
      stackMisconfigScanning={false}
      deployStack={vi.fn()}
      restartStack={vi.fn()}
      stopStack={vi.fn()}
      updateStack={vi.fn()}
      rollbackStack={vi.fn()}
      scanStackConfig={vi.fn()}
      requestDeleteStack={vi.fn()}
      requestTakeDownStack={vi.fn()}
      showTakeDown={false}
      {...over}
    />,
  );
}

describe('StackIdentityHeader', () => {
  it('renders stack identity and stack-wide actions without a header image line', () => {
    renderHeader();

    expect(screen.getByText('plex')).toBeTruthy();
    expect(screen.getByText(/running · healthy/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();

    expect(screen.queryByText(/^image$/i)).toBeNull();
    expect(screen.queryByText('nginx:alpine')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy digest' })).toBeNull();
  });

  it('shows Take down when running and showTakeDown is true', () => {
    renderHeader({ showTakeDown: true });

    expect(screen.getByTestId('stack-take-down-button')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take down' })).toBeTruthy();
  });

  it('hides Take down when showTakeDown is false', () => {
    renderHeader({ showTakeDown: false, isRunning: true });

    expect(screen.queryByTestId('stack-take-down-button')).toBeNull();
  });

  it('calls requestTakeDownStack with the stack name when Take down is clicked', async () => {
    const user = userEvent.setup();
    const requestTakeDownStack = vi.fn();
    renderHeader({ showTakeDown: true, requestTakeDownStack });

    await user.click(screen.getByTestId('stack-take-down-button'));

    expect(requestTakeDownStack).toHaveBeenCalledWith('plex');
  });

  it('does not show Take down in the overflow menu when running', async () => {
    const user = userEvent.setup();
    renderHeader({ showTakeDown: true, isRunning: true, backupInfo: { exists: true, timestamp: Date.now() } });

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('menuitem', { name: /Take down/i })).toBeNull();
  });

  it('shows Monitor in More actions and calls onOpenMonitor', async () => {
    const user = userEvent.setup();
    const onOpenMonitor = vi.fn();
    renderHeader({ onOpenMonitor, backupInfo: { exists: false, timestamp: null } });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Monitor' }));

    expect(onOpenMonitor).toHaveBeenCalledTimes(1);
  });

  it('shows stack config scanning to a deployer without requiring Admin', async () => {
    const user = userEvent.setup();
    renderHeader({
      trivy: { available: true },
      can: (action) => action === 'stack:deploy',
    });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Scan config' })).toBeInTheDocument();
  });
});
