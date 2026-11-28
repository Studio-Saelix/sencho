/**
 * StackAlertSheet Alerts tab: service targeting, services-state machine,
 * capability gating, and active-node reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
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
const useAuthMock = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
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
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue({ isAdmin: true, can: () => true });
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

  it('shows Not in compose only after a successful services list', async () => {
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
      expect(screen.getByText(/Not in compose/i)).toBeInTheDocument();
    });
  });

  it('does not show Not in compose when services fetch fails', async () => {
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
    expect(screen.queryByText(/Not in compose/i)).not.toBeInTheDocument();
  });

  it('shows a refusal for a new stack, drops the old names, and requires an explicit all-services choice', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url === '/stacks/web/services') return jsonRes(['api', 'database']);
      if (url === '/stacks/broken/services') {
        return jsonRes(
          {
            error: 'Compose file "compose.yaml" expands YAML aliases beyond the 10,000-reference budget, so Sencho refused to parse it.',
            code: 'compose_inputs_refused',
          },
          false,
          409,
        );
      }
      if (url.startsWith('/alerts') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes([]);
      }
      if (url === '/alerts' && init?.method === 'POST') {
        return jsonRes({ id: 99 }, true, 201);
      }
      return jsonRes(null, false);
    });

    const { rerender } = render(<StackAlertSheet open onOpenChange={() => {}} stackName="web" />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled());
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'api' }));
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('api');

    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="broken" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Compose file "compose.yaml" expands YAML aliases');
    expect(screen.queryByRole('button', { name: 'api' })).not.toBeInTheDocument();
    expect(screen.queryByText('All services')).not.toBeInTheDocument();
    const addRule = screen.getByRole('button', { name: 'Add Rule' });
    expect(addRule).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addRule).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    await userEvent.click(addRule);

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, init]) => String(url) === '/alerts' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.stack_name).toBe('broken');
      expect(body.service_name).toBeNull();
    });
  });

  it('blocks Add Rule while the service lookup is pending', async () => {
    let resolveServices: ((res: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolveServices = resolve; });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) return pending;
      if (url.startsWith('/alerts')) return jsonRes([]);
      return jsonRes(null, false);
    });

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    const addRule = await screen.findByRole('button', { name: 'Add Rule' });
    expect(addRule).toBeDisabled();

    await act(async () => {
      resolveServices!(jsonRes(['api', 'database']));
      await pending;
    });
    await waitFor(() => expect(addRule).toBeEnabled());
  });

  it('requires an explicit all-services choice after a generic service failure', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) return jsonRes(null, false, 500);
      if (url.startsWith('/alerts')) return jsonRes([]);
      return jsonRes(null, false);
    });

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the Compose services for this stack.');
    const addRule = screen.getByRole('button', { name: 'Add Rule' });
    expect(addRule).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addRule).toBeEnabled();
  });

  it('shows the size reason from a 413 and requires an explicit all-services choice', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) return jsonRes({ error: 'Compose file too large to parse' }, false, 413);
      if (url.startsWith('/alerts')) return jsonRes([]);
      return jsonRes(null, false);
    });

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Compose file too large to parse');
    const addRule = screen.getByRole('button', { name: 'Add Rule' });
    expect(addRule).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addRule).toBeEnabled();
  });

  it('clears the explicit all-services confirmation after a rule is added', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url.includes('/services')) return jsonRes({ error: 'Compose file too large to parse' }, false, 413);
      if (url.startsWith('/alerts') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes([]);
      }
      if (url === '/alerts' && init?.method === 'POST') {
        return jsonRes({ id: 99 }, true, 201);
      }
      return jsonRes(null, false);
    });

    render(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);
    await screen.findByRole('alert');
    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    const targetAll = screen.getByRole('checkbox', { name: /Target all services in this stack/ });
    await userEvent.click(targetAll);
    await userEvent.click(screen.getByRole('button', { name: 'Add Rule' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alert rule added.'));
    expect(targetAll).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add Rule' })).toBeDisabled();
  });

  it('ignores a late service list for a stack that is no longer selected', async () => {
    let resolveWeb: ((res: Response) => void) | undefined;
    const webPending = new Promise<Response>((resolve) => { resolveWeb = resolve; });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url === '/stacks/web/services') return webPending;
      if (url === '/stacks/broken/services') return jsonRes(['api']);
      if (url.startsWith('/alerts')) return jsonRes([]);
      return jsonRes(null, false);
    });

    const { rerender } = render(<StackAlertSheet open onOpenChange={() => {}} stackName="web" />);
    await waitFor(() => {
      expect(mockedFetch.mock.calls.some(([url]) => String(url) === '/stacks/web/services')).toBe(true);
    });

    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="broken" />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled());
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    expect(await screen.findByRole('button', { name: 'api' })).toBeInTheDocument();

    await act(async () => {
      resolveWeb!(jsonRes(['web', 'db']));
      await webPending;
    });

    expect(screen.queryByRole('button', { name: 'db' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'api' })).toBeInTheDocument();
  });

  it('ignores a late refusal for a stack that is no longer selected', async () => {
    let resolveWeb: ((res: Response) => void) | undefined;
    const webPending = new Promise<Response>((resolve) => { resolveWeb = resolve; });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents')) return jsonRes([{ type: 'discord', enabled: true }]);
      if (url === '/stacks/web/services') return webPending;
      if (url === '/stacks/broken/services') return jsonRes(['api']);
      if (url.startsWith('/alerts')) return jsonRes([]);
      return jsonRes(null, false);
    });

    const { rerender } = render(<StackAlertSheet open onOpenChange={() => {}} stackName="web" />);
    await waitFor(() => {
      expect(mockedFetch.mock.calls.some(([url]) => String(url) === '/stacks/web/services')).toBe(true);
    });

    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="broken" />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled());
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    expect(await screen.findByRole('button', { name: 'api' })).toBeInTheDocument();

    await act(async () => {
      resolveWeb!(jsonRes(
        { error: 'Compose file "compose.yaml" is too complex to list.', code: 'compose_inputs_refused' },
        false,
        409,
      ));
      await webPending;
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'api' })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByText(/Not in compose/i)).not.toBeInTheDocument());

    nodeState.activeNode = { id: 2, type: 'remote', name: 'Remote' };
    nodeState.activeNodeMeta = {
      version: '1.0.0',
      capabilities: ['service-scoped-stack-alert'],
    };
    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" />);

    await waitFor(() => expect(servicesCalls).toBe(2));
    // New node's list has only worker, so the api-targeted rule is missing.
    await waitFor(() => expect(screen.getByText(/Not in compose/i)).toBeInTheDocument());
  });

  it('prefills the Service combobox from initialService when listed', async () => {
    mockHappyPath(['api', 'database']);
    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialService="api"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Add Rule')).toBeInTheDocument();
      expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('api');
    });
  });

  it('does not silently target all services when the requested service is absent', async () => {
    mockHappyPath(['api']);
    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialService="on"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Service "on" is not in this stack's compose file/)).toBeInTheDocument();
    });
    const addRule = screen.getByRole('button', { name: 'Add Rule' });
    fireEvent.change(screen.getByPlaceholderText('e.g. 90'), { target: { value: '80' } });
    expect(addRule).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addRule).toBeEnabled();
  });

  it('ignores Alerts initialService when service-scoped capability is absent', async () => {
    nodeState.activeNodeMeta = { version: '0.90.0', capabilities: [] };
    mockHappyPath(['api', 'database']);
    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialService="api"
      />,
    );

    await waitFor(() => expect(screen.getByText('Add Rule')).toBeInTheDocument());
    expect(screen.queryByText('All services')).toBeNull();
    expect(
      mockedFetch.mock.calls.some(([url]) => String(url).includes('/services')),
    ).toBe(false);
  });

  it('prefills Auto-heal Service from initialService when listed', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url.includes('/services')) return jsonRes(['api', 'database']);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialTab="auto-heal"
        initialService="api"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Add Policy')).toBeInTheDocument();
      expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('api');
    });
  });

  it('shows an auto-heal refusal for a new stack and requires an explicit all-services choice', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/auto-heal/policies') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes([]);
      }
      if (url === '/stacks/web/services') return jsonRes(['api', 'database']);
      if (url === '/stacks/broken/services') {
        return jsonRes(
          {
            error: 'Compose file "compose.yaml" expands YAML aliases beyond the 10,000-reference budget, so Sencho refused to parse it.',
            code: 'compose_inputs_refused',
          },
          false,
          409,
        );
      }
      if (url === '/auto-heal/policies' && init?.method === 'POST') {
        return jsonRes({ id: 99 }, true, 201);
      }
      return jsonRes(null, false);
    });

    const { rerender } = render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="web" initialTab="auto-heal" />,
    );
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled());
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'api' }));
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('api');

    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="broken" initialTab="auto-heal" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Compose file "compose.yaml" expands YAML aliases');
    expect(screen.queryByRole('button', { name: 'api' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const addPolicy = screen.getByRole('button', { name: 'Add Policy' });
    expect(addPolicy).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addPolicy).toBeEnabled();
    await userEvent.click(addPolicy);

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, init]) => String(url) === '/auto-heal/policies' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.stack_name).toBe('broken');
      expect(body.service_name).toBeNull();
    });
  });

  it('does not silently target all services in auto-heal when the requested service is absent', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url.includes('/services')) return jsonRes(['api']);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialTab="auto-heal"
        initialService="on"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Service "on" is not in this stack's compose file/)).toBeInTheDocument();
    });
    const addPolicy = screen.getByRole('button', { name: 'Add Policy' });
    expect(addPolicy).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addPolicy).toBeEnabled();
  });

  it('requires an explicit all-services choice after a generic auto-heal service failure', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url.includes('/services')) return jsonRes(null, false, 500);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" initialTab="auto-heal" />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the Compose services for this stack.');
    const addPolicy = screen.getByRole('button', { name: 'Add Policy' });
    expect(addPolicy).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addPolicy).toBeEnabled();
  });

  it('blocks Add Policy while the auto-heal service lookup is pending', async () => {
    let resolveServices: ((res: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolveServices = resolve; });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url.includes('/services')) return pending;
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" initialTab="auto-heal" />,
    );

    const addPolicy = await screen.findByRole('button', { name: 'Add Policy' });
    expect(addPolicy).toBeDisabled();

    await act(async () => {
      resolveServices!(jsonRes(['api', 'database']));
      await pending;
    });
    await waitFor(() => expect(addPolicy).toBeEnabled());
  });

  it('shows the size reason from a 413 in auto-heal and requires an explicit all-services choice', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url.includes('/services')) return jsonRes({ error: 'Compose file too large to parse' }, false, 413);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" initialTab="auto-heal" />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Compose file too large to parse');
    const addPolicy = screen.getByRole('button', { name: 'Add Policy' });
    expect(addPolicy).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Target all services in this stack/ }));
    expect(addPolicy).toBeEnabled();
  });

  it('clears the explicit all-services confirmation after a policy is added', async () => {
    mockedFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/auto-heal/policies') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes([]);
      }
      if (url === '/auto-heal/policies' && init?.method === 'POST') {
        return jsonRes({ id: 99 }, true, 201);
      }
      if (url.includes('/services')) return jsonRes(null, false, 500);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="my-stack" initialTab="auto-heal" />,
    );
    await screen.findByRole('alert');
    const targetAll = screen.getByRole('checkbox', { name: /Target all services in this stack/ });
    await userEvent.click(targetAll);
    await userEvent.click(screen.getByRole('button', { name: 'Add Policy' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy added.'));
    expect(targetAll).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add Policy' })).toBeDisabled();
  });

  it('ignores a late auto-heal service list for a stack that is no longer selected', async () => {
    let resolveWeb: ((res: Response) => void) | undefined;
    const webPending = new Promise<Response>((resolve) => { resolveWeb = resolve; });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) return jsonRes([]);
      if (url === '/stacks/web/services') return webPending;
      if (url === '/stacks/broken/services') return jsonRes(['api']);
      return jsonRes(null, false);
    });

    const { rerender } = render(
      <StackAlertSheet open onOpenChange={() => {}} stackName="web" initialTab="auto-heal" />,
    );
    await waitFor(() => {
      expect(mockedFetch.mock.calls.some(([url]) => String(url) === '/stacks/web/services')).toBe(true);
    });

    rerender(<StackAlertSheet open onOpenChange={() => {}} stackName="broken" initialTab="auto-heal" />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled());
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    expect(await screen.findByRole('button', { name: 'api' })).toBeInTheDocument();

    await act(async () => {
      resolveWeb!(jsonRes(['web', 'db']));
      await webPending;
    });

    expect(screen.queryByRole('button', { name: 'db' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'api' })).toBeInTheDocument();
  });
});

describe('StackAlertSheet permission gating (stack:edit deny path)', () => {
  it('AlertsTab hides Add new rule and the delete-alert control when the caller lacks stack:edit', async () => {
    useAuthMock.mockReturnValue({
      isAdmin: false,
      can: (action: string) => action !== 'stack:edit',
    });
    mockHappyPath(['api'], [{
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

    // Reads stay visible: the rule itself still renders for a stack:read-only caller.
    await waitFor(() => expect(screen.getByText('api')).toBeInTheDocument());
    expect(screen.queryByText('Add Rule')).toBeNull();
    expect(screen.queryByText('Add new rule')).toBeNull();
    expect(screen.queryByLabelText('Delete alert')).toBeNull();
  });

  it('AutoHealTab hides Add new policy and PolicyRow edit affordances when the caller lacks stack:edit', async () => {
    useAuthMock.mockReturnValue({
      isAdmin: false,
      can: (action: string) => action !== 'stack:edit',
    });
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auto-heal/policies')) {
        return jsonRes([{
          id: 1,
          stack_name: 'my-stack',
          service_name: null,
          unhealthy_duration_mins: 5,
          cooldown_mins: 5,
          max_restarts_per_hour: 3,
          auto_disable_after_failures: 5,
          enabled: 1,
          consecutive_failures: 0,
        }]);
      }
      if (url.includes('/services')) return jsonRes(['api', 'database']);
      return jsonRes(null, false);
    });

    render(
      <StackAlertSheet
        open
        onOpenChange={() => {}}
        stackName="my-stack"
        initialTab="auto-heal"
      />,
    );

    // Reads stay visible: the policy row itself still renders.
    await waitFor(() => expect(screen.getByText('All services')).toBeInTheDocument());
    expect(screen.queryByText('Add Policy')).toBeNull();
    expect(screen.queryByLabelText(/toggle policy for/i)).toBeNull();
    expect(screen.queryByLabelText('Delete policy')).toBeNull();
    // History is not edit-gated and should remain available either way.
    expect(screen.getByLabelText('Toggle history')).toBeInTheDocument();
  });
});
