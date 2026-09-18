import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSourceSecretsSection } from './GitSourceSecretsSection';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const IDENTITY = {
  id: 'id-1',
  recipient: 'age1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopq',
  label: null,
  createdAt: 1,
  rotatedAt: null,
};

const SECRETS = {
  encrypted_source_policy: 'allow_plaintext' as const,
  identities: [IDENTITY],
  readiness: {
    identities: [IDENTITY],
    requiredRecipients: [],
    ready: true,
    policy: 'allow_plaintext' as const,
  },
};

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  mockedFetch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe('GitSourceSecretsSection', () => {
  it('hides mutate controls when canEdit is false', async () => {
    mockedFetch.mockResolvedValue(jsonRes(SECRETS));
    render(<GitSourceSecretsSection stackName="web" canEdit={false} linked />);
    await screen.findByTestId('git-source-secrets-readiness');
    expect(screen.queryByRole('button', { name: /generate identity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete identity/i })).not.toBeInTheDocument();
  });

  it('saves policy through the dedicated endpoint', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonRes(SECRETS))
      .mockResolvedValueOnce(jsonRes({ encrypted_source_policy: 'require_encrypted' }))
      .mockResolvedValue(jsonRes({
        ...SECRETS,
        encrypted_source_policy: 'require_encrypted',
        readiness: { ...SECRETS.readiness, policy: 'require_encrypted' },
      }));

    render(<GitSourceSecretsSection stackName="web" canEdit linked />);
    await screen.findByRole('button', { name: /require sops encryption/i });
    await userEvent.click(screen.getByRole('button', { name: /require sops encryption/i }));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        '/stacks/web/git-source/encrypted-source-policy',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ encrypted_source_policy: 'require_encrypted' }),
        }),
      );
    });
    expect(mockedFetch.mock.calls.some((call) => String(call[0]).includes('/git-source') && call[1]?.method === 'PUT' && !String(call[0]).includes('encrypted-source-policy'))).toBe(false);
  });

  it('opens the impact modal when delete returns 409', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonRes(SECRETS))
      .mockResolvedValueOnce(jsonRes({
        impact: [{
          generationId: 'gen-1',
          commitSha: 'abcdef1234567890',
          status: 'accepted',
          requiredRecipients: [IDENTITY.recipient],
        }],
      }, false, 409))
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValue(jsonRes({ ...SECRETS, identities: [] }));

    render(<GitSourceSecretsSection stackName="web" canEdit linked />);
    await screen.findByRole('button', { name: /delete identity/i });
    await userEvent.click(screen.getByRole('button', { name: /delete identity/i }));

    expect(await screen.findByRole('heading', { name: 'Delete age identity' })).toBeInTheDocument();
    expect(screen.getByText(/Affected generations: abcdef1 \(accepted\)/)).toBeInTheDocument();

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        '/stacks/web/git-source/sops-identities/id-1',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ acknowledge_destructive: true }),
        }),
      );
    });
  });
});
