import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nodeState = vi.hoisted(() => ({ nodes: [] as unknown[] }));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: nodeState.nodes, refreshNodes: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import type { Node } from '@/context/NodeContext';
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


function EditHarness({ node }: { node: Node }) {
  const { openEdit, NodeActionModals } = useNodeActions();
  return (
    <>
      <button type="button" onClick={() => openEdit(node)}>Edit</button>
      {NodeActionModals}
    </>
  );
}

function pilotNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 11,
    name: 'edge-01',
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/opt/docker/sencho',
    is_default: false,
    status: 'offline',
    created_at: 1,
    pilot_last_seen: 1_700_000_000,
    cordoned: false,
    cordoned_at: null,
    cordoned_reason: null,
    ...overrides,
  } as Node;
}

describe('useNodeActions Compose directory lock', () => {
  it('locks the field for a connected Pilot and names relocation', () => {
    nodeState.nodes = [pilotNode()];
    render(<EditHarness node={pilotNode()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Compose Directory')).toBeDisabled();
    expect(screen.getByText(/fixed after the Pilot connects.*separate relocation operation/i)).toBeInTheDocument();
  });

  it('keeps the field editable for a Pilot that has never connected', () => {
    const node = pilotNode({ pilot_last_seen: null });
    nodeState.nodes = [node];
    render(<EditHarness node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByLabelText('Compose Directory');
    expect(field).not.toBeDisabled();
    expect(screen.getByText(/does not move an already deployed agent/i)).toBeInTheDocument();
  });

  it('submits the unchanged directory for a connected Pilot', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const node = pilotNode();
    nodeState.nodes = [node];
    render(<EditHarness node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'edge-renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body.compose_dir).toBe('/opt/docker/sencho');
    expect(body.name).toBe('edge-renamed');
  });
});
