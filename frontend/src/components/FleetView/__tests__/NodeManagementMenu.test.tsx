import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeManagementMenu } from '../NodeManagementMenu';
import type { NodeManagementActions } from '../types';

function actions(overrides: Partial<NodeManagementActions> = {}): NodeManagementActions {
  return {
    canConnectExisting: true,
    canBootstrapServer: true,
    checkingUpdates: false,
    onConnectExisting: vi.fn(),
    onBootstrapServer: vi.fn(),
    onCheckUpdates: vi.fn(),
    ...overrides,
  };
}

describe('NodeManagementMenu', () => {
  it('shows one trigger with both sections and all three items', async () => {
    const user = userEvent.setup();
    render(<NodeManagementMenu actions={actions()} />);
    await user.click(screen.getByRole('button', { name: 'Node management' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Connect existing node/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Bootstrap new Linux server/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Node updates/ })).toBeInTheDocument();
  });

  it('calls the existing handlers for each item', async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<NodeManagementMenu actions={props} />);

    await user.click(screen.getByRole('button', { name: 'Node management' }));
    await user.click(screen.getByRole('menuitem', { name: /Connect existing node/ }));
    expect(props.onConnectExisting).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Node management' }));
    await user.click(screen.getByRole('menuitem', { name: /Bootstrap new Linux server/ }));
    expect(props.onBootstrapServer).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Node management' }));
    await user.click(screen.getByRole('menuitem', { name: /Node updates/ }));
    expect(props.onCheckUpdates).toHaveBeenCalledTimes(1);
  });

  it('hides Bootstrap from a non-admin and keeps Connect', async () => {
    const user = userEvent.setup();
    render(<NodeManagementMenu actions={actions({ canBootstrapServer: false })} />);
    await user.click(screen.getByRole('button', { name: 'Node management' }));
    expect(screen.getByRole('menuitem', { name: /Connect existing node/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Bootstrap new Linux server/ })).not.toBeInTheDocument();
  });

  it('hides the whole Onboarding section when neither onboarding action is available', async () => {
    const user = userEvent.setup();
    render(<NodeManagementMenu actions={actions({ canConnectExisting: false, canBootstrapServer: false })} />);
    await user.click(screen.getByRole('button', { name: 'Node management' }));
    expect(screen.queryByText('Onboarding')).not.toBeInTheDocument();
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Node updates/ })).toBeInTheDocument();
  });

  it('disables the update item while a check is in flight and exposes aria-busy', async () => {
    const user = userEvent.setup();
    render(<NodeManagementMenu actions={actions({ checkingUpdates: true })} />);
    await user.click(screen.getByRole('button', { name: 'Node management' }));
    const item = screen.getByRole('menuitem', { name: /Node updates/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('aria-busy', 'true');
  });

  it('opens and closes with the keyboard and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<NodeManagementMenu actions={actions()} />);
    const trigger = screen.getByRole('button', { name: 'Node management' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
