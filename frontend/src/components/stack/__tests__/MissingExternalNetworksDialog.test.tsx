import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  MissingExternalNetworksDialog,
  type MissingExternalNetworksPayload,
} from '../MissingExternalNetworksDialog';

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const safePayload: MissingExternalNetworksPayload = {
  status: 'ok',
  autoCreateEnabled: false,
  stackName: 'media',
  networks: [
    {
      name: 'arr-net',
      keys: ['arr'],
      declarations: [{ key: 'arr', driverKind: 'bridge', unsupportedFeatures: [] }],
      safe: true,
      unsupportedFeatures: [],
      creationSpec: { driver: 'bridge', options: 'default' },
    },
  ],
};

describe('MissingExternalNetworksDialog', () => {
  it('enables Create and continue for admin when all networks are safe', async () => {
    const onCreateAndContinue = vi.fn();
    const user = userEvent.setup();
    render(
      <MissingExternalNetworksDialog
        open
        payload={safePayload}
        isAdmin
        onCancel={vi.fn()}
        onOpenNetworking={vi.fn()}
        onCreateAndContinue={onCreateAndContinue}
      />,
    );
    const create = screen.getByRole('button', { name: 'Create and continue' });
    expect(create).toBeEnabled();
    await user.click(create);
    expect(onCreateAndContinue).toHaveBeenCalledOnce();
  });

  it('disables Create and continue for non-admin', () => {
    render(
      <MissingExternalNetworksDialog
        open
        payload={safePayload}
        isAdmin={false}
        onCancel={vi.fn()}
        onOpenNetworking={vi.fn()}
        onCreateAndContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create and continue' })).toBeDisabled();
  });

  it('disables Create when any network is unsafe', () => {
    render(
      <MissingExternalNetworksDialog
        open
        payload={{
          ...safePayload,
          networks: [
            {
              ...safePayload.networks[0],
              safe: false,
              blockReason: 'unsupported_driver',
              creationSpec: null,
              declarations: [{ key: 'arr', driverKind: 'macvlan', unsupportedFeatures: [] }],
            },
          ],
        }}
        isAdmin
        onCancel={vi.fn()}
        onOpenNetworking={vi.fn()}
        onCreateAndContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create and continue' })).toBeDisabled();
  });
});
