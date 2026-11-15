import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { StackSection } from '../NodeCardStackList';

const REASON = 'Sencho refused to read docker-compose.yml: the YAML aliases expand past the limit.';

function renderList() {
  return render(
    <StackSection stackName="bomb" nodeId={2} onNavigate={vi.fn()} />,
  );
}

describe("StackSection container expansion", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('names the refusal when the node refuses the stack, through the same 409 the proxy carries', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(
      JSON.stringify({ error: REASON, code: 'compose_inputs_refused' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));
    renderList();
    await userEvent.click(screen.getByText('bomb'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REASON));
  });

  it('keeps the generic wording for any other failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('nope', { status: 500 }));
    renderList();
    await userEvent.click(screen.getByText('bomb'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to load containers for bomb'));
  });
});
