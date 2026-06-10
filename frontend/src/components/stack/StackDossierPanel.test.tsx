/**
 * Covers the Dossier editor: it loads saved fields, enables Save only after an
 * edit (then PUTs the document), renders read-only for users who cannot edit,
 * surfaces a distinct retry state on load failure (without blanking), keeps the
 * form dirty when a save fails, coerces non-string payloads, and wires the
 * copy/download exports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 } }) }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/download', () => ({ downloadTextFile: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';
import { downloadTextFile } from '@/lib/download';
import StackDossierPanel from './StackDossierPanel';
import { EMPTY_DOSSIER_FIELDS } from '@/lib/dossierMarkdown';
import type { AnatomyMarkdownInput } from '@/lib/anatomyMarkdown';

const anatomy: AnatomyMarkdownInput = {
  stackName: 'web', services: ['web'], ports: {}, volumes: {}, restart: null,
  envFile: null, envVarCount: 0, missingVars: [], networkName: 'web_default', gitSource: null,
};

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StackDossierPanel', () => {
  it('loads saved fields into the form', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, purpose: 'Reverse proxy' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);
    await waitFor(() =>
      expect((screen.getByTestId('dossier-field-purpose') as HTMLInputElement).value).toBe('Reverse proxy'),
    );
  });

  it('enables save only after an edit and PUTs the document', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_endpoint: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? jsonRes({ ...EMPTY_DOSSIER_FIELDS, owner: 'ops' })
        : jsonRes({ ...EMPTY_DOSSIER_FIELDS }),
    );
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);

    const saveBtn = await screen.findByTestId('dossier-save-btn');
    expect(saveBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId('dossier-field-owner'), { target: { value: 'ops' } });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = vi.mocked(apiFetch).mock.calls.find(([, o]) => (o as { method?: string } | undefined)?.method === 'PUT');
      expect(putCall).toBeTruthy();
    });
  });

  it('renders read-only (no save button, disabled inputs) for users who cannot edit', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS }));
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit={false} />);
    await screen.findByTestId('dossier-panel');
    expect(screen.queryByTestId('dossier-save-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('dossier-field-purpose')).toBeDisabled();
  });

  it('disables the export buttons when compose cannot be parsed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS }));
    render(<StackDossierPanel stackName="web" anatomy={null} canEdit />);
    await screen.findByTestId('dossier-panel');
    expect(screen.getByTestId('dossier-copy-btn')).toBeDisabled();
    expect(screen.getByTestId('dossier-download-btn')).toBeDisabled();
  });

  it('shows a retry state (not a blank form) when the load fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ error: 'down' }, false));
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);
    await screen.findByTestId('dossier-retry-btn');
    // The form must NOT render blank fields that could be mistaken for "no notes".
    expect(screen.queryByTestId('dossier-field-purpose')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('keeps the form dirty when a save fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_endpoint: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? jsonRes({ error: 'boom' }, false)
        : jsonRes({ ...EMPTY_DOSSIER_FIELDS }),
    );
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);
    const saveBtn = await screen.findByTestId('dossier-save-btn');
    fireEvent.change(screen.getByTestId('dossier-field-owner'), { target: { value: 'ops' } });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(saveBtn).not.toBeDisabled(); // still dirty: the failed save did not advance the baseline
  });

  it('coerces non-string payload values to empty strings', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ purpose: null, owner: 5, custom_notes: 'keep' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);
    await waitFor(() =>
      expect((screen.getByTestId('dossier-field-custom_notes') as HTMLTextAreaElement).value).toBe('keep'),
    );
    expect((screen.getByTestId('dossier-field-purpose') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('dossier-field-owner') as HTMLInputElement).value).toBe('');
  });

  it('wires copy and download to the combined Markdown', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS }));
    render(<StackDossierPanel stackName="web" anatomy={anatomy} canEdit />);
    await screen.findByTestId('dossier-panel');

    fireEvent.click(screen.getByTestId('dossier-copy-btn'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toContain('# web');

    fireEvent.click(screen.getByTestId('dossier-download-btn'));
    expect(downloadTextFile).toHaveBeenCalledWith('web-dossier.md', expect.stringContaining('# web'));
  });

  // Anatomy that publishes a single TCP host port, for documentation-drift tests.
  const anatomyPublishing = (host: string): AnatomyMarkdownInput => ({
    ...anatomy,
    ports: { web: [{ host, container: '80', proto: 'tcp' }] },
  });

  it('warns when an access URL names a port the stack does not publish', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:32400' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('32401')} canEdit />);
    expect(await screen.findByTestId('dossier-doc-drift')).toHaveTextContent(':32400');
  });

  it('does not warn when the access URL port is published', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:32400' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('32400')} canEdit />);
    await screen.findByTestId('dossier-panel');
    expect(screen.queryByTestId('dossier-doc-drift')).not.toBeInTheDocument();
  });

  it('shows the drift warning to read-only viewers', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:32400' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('32401')} canEdit={false} />);
    expect(await screen.findByTestId('dossier-doc-drift')).toBeInTheDocument();
  });

  it('updates the warning live as access_urls is edited', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('8080')} canEdit />);
    await screen.findByTestId('dossier-panel');
    expect(screen.queryByTestId('dossier-doc-drift')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('dossier-field-access_urls'), { target: { value: 'http://host:9000' } });
    expect(await screen.findByTestId('dossier-doc-drift')).toHaveTextContent(':9000');
  });

  it('clears the warning when the URL is edited to a published port', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:9000' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('8080')} canEdit />);
    await screen.findByTestId('dossier-doc-drift');
    fireEvent.change(screen.getByTestId('dossier-field-access_urls'), { target: { value: 'http://host:8080' } });
    await waitFor(() => expect(screen.queryByTestId('dossier-doc-drift')).not.toBeInTheDocument());
  });

  it('renders one row per unpublished port', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:9000\nhttp://host:9001' }));
    render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('8080')} canEdit />);
    const section = await screen.findByTestId('dossier-doc-drift');
    expect(section).toHaveTextContent(':9000');
    expect(section).toHaveTextContent(':9001');
  });

  it('suppresses the warning when a reload fails, never showing the previous stack stale', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ ...EMPTY_DOSSIER_FIELDS, access_urls: 'http://host:9000' }))
      .mockResolvedValueOnce(jsonRes({ error: 'down' }, false));
    const { rerender } = render(<StackDossierPanel stackName="web" anatomy={anatomyPublishing('8080')} canEdit />);
    expect(await screen.findByTestId('dossier-doc-drift')).toHaveTextContent(':9000');
    // Switch stacks: the reload fails, so the prior stack's drifting fields stay
    // resident but must not keep a warning on screen.
    rerender(<StackDossierPanel stackName="web2" anatomy={anatomyPublishing('8080')} canEdit />);
    await screen.findByTestId('dossier-retry-btn');
    expect(screen.queryByTestId('dossier-doc-drift')).not.toBeInTheDocument();
  });
});
