import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapTargetStep } from '../BootstrapTargetStep';
import { useNodeBootstrap } from '../useNodeBootstrap';
import { BootstrapApiError, FALLBACK_CAPABILITIES } from '../bootstrapApi';

function Harness() {
  const wizard = useNodeBootstrap({
    open: true,
    api: {
      capabilities: vi.fn(async () => FALLBACK_CAPABILITIES),
      hostKey: vi.fn(),
      preflight: vi.fn(),
    },
  });
  return <BootstrapTargetStep wizard={wizard} />;
}

function renderStep() {
  return render(<Harness />);
}

describe('BootstrapTargetStep', () => {
  it('prefills both directory defaults and keeps the advanced field collapsed', () => {
    renderStep();
    expect(screen.getByLabelText('Compose stacks directory')).toHaveValue('/opt/docker/sencho');
    const disclosure = screen.getByRole('button', { name: /Advanced configuration/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Pilot Agent installation directory')).not.toBeInTheDocument();
  });

  it('expands and collapses the advanced disclosure with aria wiring', async () => {
    const user = userEvent.setup();
    renderStep();
    const disclosure = screen.getByRole('button', { name: /Advanced configuration/ });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('aria-controls');
    expect(screen.getByLabelText('Pilot Agent installation directory')).toHaveValue('/opt/sencho-agent');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a custom agent path in the collapsed trigger instead of hiding it', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Advanced configuration/ }));
    const field = screen.getByLabelText('Pilot Agent installation directory');
    await user.clear(field);
    await user.type(field, '/srv/sencho-agent');
    await user.click(screen.getByRole('button', { name: /Advanced configuration/ }));
    expect(screen.getByRole('button', { name: /Advanced configuration/ })).toHaveTextContent('/srv/sencho-agent');
  });

  it('resets the agent directory to the default', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Advanced configuration/ }));
    const field = screen.getByLabelText('Pilot Agent installation directory');
    await user.clear(field);
    await user.type(field, '/srv/sencho-agent');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(field).toHaveValue('/opt/sencho-agent');
  });

  it('validates paths inline without blocking typing', async () => {
    const user = userEvent.setup();
    renderStep();
    const field = screen.getByLabelText('Compose stacks directory');
    await user.clear(field);
    await user.type(field, '/etc/stacks');
    expect(screen.getByRole('alert')).toHaveTextContent('must not be under /etc');
    // The value stays as typed; feedback never rewrites the field.
    expect(field).toHaveValue('/etc/stacks');
  });

  it('shows the two-directory distinction helper text', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Advanced configuration/ }));
    expect(screen.getByText(/Separate from the stacks directory, so the agent is never listed as a stack/)).toBeInTheDocument();
    expect(screen.getByText(/Persistent agent data stays in the sencho-agent-data volume/)).toBeInTheDocument();
  });
});

describe('useNodeBootstrap field errors at the step level', () => {
  it('marks the compose field invalid when the server rejects the path', async () => {
    const { result: hook } = renderHook(() => useNodeBootstrap({
      open: true,
      api: {
        capabilities: vi.fn(async () => FALLBACK_CAPABILITIES),
        hostKey: vi.fn(async () => ({
          host: 'server.example.com',
          port: 22,
          address: '192.168.1.50',
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
          knownHostsLine: 'line',
          trust: 'unknown' as const,
          pinnedFingerprint: null,
        })),
        preflight: vi.fn(async () => {
          throw new BootstrapApiError('The Compose directory is not allowed.', 'INVALID_PATH', 'composeDir');
        }),
      },
    }));

    // Drive the same actions the step exposes, without reaching into the DOM:
    // the field error is what the Input renders as its alert.
    await act(async () => {
      hook.current.setField('targetName', 'media-server');
      hook.current.setField('host', 'server.example.com');
      hook.current.setField('username', 'ubuntu');
      hook.current.setField('privateKey', 'key');
    });
    await act(async () => { await hook.current.checkHostKey(); });
    await act(async () => { await hook.current.runPreflight(); });

    expect(hook.current.fieldError('composeDir')).toBe('The Compose directory is not allowed.');
  });
});
