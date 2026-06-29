import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [], refreshNodes: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { useNodeActions } from '../useNodeActions';

function Harness() {
  const { openCreate, NodeActionModals } = useNodeActions();
  return (
    <>
      <button type="button" onClick={openCreate}>Open</button>
      {NodeActionModals}
    </>
  );
}

describe('useNodeActions Pilot defaults', () => {
  it('starts Pilot enrollment with the 1:1 host compose path', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByLabelText('Compose Directory')).toHaveValue('/opt/docker/sencho');
    expect(screen.getByText(/mounts this same path inside the container/i)).toBeInTheDocument();
  });

  it('uses the standard compose default for proxy mode', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }));
    fireEvent.click(screen.getByRole('button', { name: /Distributed API Proxy/i }));

    expect(screen.getByLabelText('Compose Directory')).toHaveValue('/app/compose');
  });

  it('preserves an operator-entered compose path when the mode changes', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const composeDir = screen.getByLabelText('Compose Directory');
    fireEvent.change(composeDir, { target: { value: '/srv/stacks' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }));
    fireEvent.click(screen.getByRole('button', { name: /Distributed API Proxy/i }));

    expect(composeDir).toHaveValue('/srv/stacks');
  });
});
