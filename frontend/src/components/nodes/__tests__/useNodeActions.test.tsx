import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [], refreshNodes: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
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

function enrollmentResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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

  it('shows the hub CA step when enrollment includes caPem', async () => {
    vi.mocked(apiFetch).mockResolvedValue(enrollmentResponse({
      id: 9,
      enrollment: {
        token: 'tok',
        expiresAt: Date.now() + 15 * 60 * 1000,
        composeYaml: 'name: sencho-agent\n',
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      },
    }));

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edge-tls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));

    await waitFor(() => {
      expect(screen.getByText(/save the hub CA as/i)).toBeInTheDocument();
    });
    expect(screen.getByText('sencho-hub-ca.pem')).toBeInTheDocument();
    expect(screen.getByText(/BEGIN CERTIFICATE/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy CA file' })).toBeInTheDocument();
  });

  it('omits the hub CA step when enrollment has no caPem', async () => {
    vi.mocked(apiFetch).mockResolvedValue(enrollmentResponse({
      id: 10,
      enrollment: {
        token: 'tok',
        expiresAt: Date.now() + 15 * 60 * 1000,
        composeYaml: 'name: sencho-agent\n',
      },
    }));

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edge-plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));

    await waitFor(() => {
      expect(screen.getByText(/save the file as/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/save the hub CA as/i)).not.toBeInTheDocument();
  });
});
