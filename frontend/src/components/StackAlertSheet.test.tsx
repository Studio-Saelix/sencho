/**
 * StackAlertSheet Alerts tab: service targeting, services-state machine,
 * capability gating, and active-node reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { nodeState } = vi.hoisted(() => ({
  nodeState: {
    activeNode: { id: 1, type: 'local', name: 'Local' } as { id: number; type: string; name: string } | null,
    activeNodeMeta: {
      version: '1.0.0',
      capabilities: ['service-scoped-stack-alert'],
    } as { version: string; capabilities: string[] } | null,
  },
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: nodeState.activeNode,
    activeNodeMeta: nodeState.activeNodeMeta,
    hasCapability: (cap: string) => nodeState.activeNodeMeta?.capabilities.includes(cap) === true,
  }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { StackAlertSheet } from './StackAlertSheet';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  nodeState.activeNode = { id: 1, type: 'local', name: 'Local' };
  nodeState.activeNodeMeta = {
    version: '1.0.0',
    capabilities: ['service-scoped-stack-alert'],
  };
  mockedFetch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

function mockHappyPath(services: string[] = ['api', 'database'], alerts: unknown[] = []) {
  mockedFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/agents')) {
      return jsonRes([{ type: 'discord', enabled: true }]);
    }
    if (url.includes('/services')) {
      return jsonRes(services);
    }
    if (url.startsWith('/alerts') && (!init || !init.method || init.method === 'GET')) {
      return jsonRes(alerts);
    }
    if (url === '/alerts' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return jsonRes({ id: 99, ...body }, true, 201);
    }
    return jsonRes(null, false);
  });
}

describe('StackAlertSheet Alerts tab', () => {
  it('POSTs selected service_name when capability is present', async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => expect(screen.getByText('Add Rule')).toBeInTheDocument());
    await waitFor(() => {
      expect(mockedFetch.mock.calls.some(([url]) => String(url).includes('/services'))).toBe(true);
    });

    // Service combobox is the first one in the Add new rule form.
    await waitFor(() => {
      const serviceBox = screen.getAllByRole('combobox')[0];
      expect(serviceBox).not.toBeDisabled();
    });
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('button', { name: 'api' }));

    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    await user.click(screen.getByText('Add Rule'));

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, init]) => String(url) === '/alerts' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.service_name).toBe('api');
      expect(body.stack_name).toBe('my-stack');
    });
  });

  it('POSTs service_name null for All services', async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);
    await waitFor(() => expect(screen.getByText('Add Rule')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    await user.click(screen.getByText('Add Rule'));

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, init]) => String(url) === '/alerts' && (init as RequestInit | undefined)?.method === 'POST',
      );
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.service_name).toBeNull();
    });
  });

  it('shows Service missing only after a successful services list', async () => {
    mockHappyPath(['database'], [{
      id: 1,
      stack_name: 'my-stack',
      service_name: 'api',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 5,
      cooldown_mins: 60,
    }]);

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => {
      expect(screen.getByText(/Service missing/i)).toBeInTheDocument();
    });
  });

  it('does not show Service missing when services fetch fails', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) return jsonRes(null, false, 500);
      if (url.includes('/alerts')) {
        return jsonRes([{
          id: 1,
          stack_name: 'my-stack',
          service_name: 'api',
          metric: 'cpu_percent',
          operator: '>',
          threshold: 80,
          duration_mins: 5,
          cooldown_mins: 60,
        }]);
      }
      return jsonRes(null, false);
    });

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => expect(screen.getByText('api')).toBeInTheDocument());
    expect(screen.queryByText(/Service missing/i)).not.toBeInTheDocument();
  });

  it('hides service selector when capability is missing and posts null', async () => {
    nodeState.activeNodeMeta = { version: '0.90.0', capabilities: [] };
    mockHappyPath();
    const user = userEvent.setup();

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => expect(screen.getByText('Add Rule')).toBeInTheDocument());
    expect(screen.queryByText(/does not support service-scoped/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /all services/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    await user.click(screen.getByText('Add Rule'));

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, init]) => String(url) === '/alerts' && (init as RequestInit | undefined)?.method === 'POST',
      );
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.service_name).toBeNull();
    });
  });

  it('resets services state when active node changes', async () => {
    let servicesCalls = 0;
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) {
        servicesCalls += 1;
        return jsonRes(servicesCalls === 1 ? ['api'] : ['worker']);
      }
      if (url.includes('/alerts')) {
        return jsonRes([{
          id: 1,
          stack_name: 'my-stack',
          service_name: 'api',
          metric: 'cpu_percent',
          operator: '>',
          threshold: 80,
          duration_mins: 5,
          cooldown_mins: 60,
        }]);
      }
      return jsonRes(null, false);
    });

    const { rerender } = render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />,
    );

    await waitFor(() => expect(servicesCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Service missing/i)).not.toBeInTheDocument());

    nodeState.activeNode = { id: 2, type: 'remote', name: 'Remote' };
    nodeState.activeNodeMeta = {
      version: '1.0.0',
      capabilities: ['service-scoped-stack-alert'],
    };
    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => expect(servicesCalls).toBe(2));
    // New node's list has only worker, so the api-targeted rule is missing.
    await waitFor(() => expect(screen.getByText(/Service missing/i)).toBeInTheDocument());
  });
});
