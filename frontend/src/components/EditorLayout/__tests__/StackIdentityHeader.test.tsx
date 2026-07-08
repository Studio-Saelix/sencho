import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      isAdmin
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

    expect(screen.getByText('plex')).toBeInTheDocument();
    expect(screen.getByText(/running · healthy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();

    expect(screen.queryByText(/^image$/i)).not.toBeInTheDocument();
    expect(screen.queryByText('nginx:alpine')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy digest' })).not.toBeInTheDocument();
  });
});
