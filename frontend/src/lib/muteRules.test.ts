import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createMuteRule, stackMuteAllDraft, nodeMuteUpdatesDraft } from './muteRules';

describe('muteRules schedule defaults', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('createMuteRule sends schedule null when draft omits it', async () => {
    await createMuteRule(stackMuteAllDraft('web'));
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/notification-suppression-rules',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"schedule":null'),
      }),
    );
  });
});

describe('nodeMuteUpdatesDraft', () => {
  it('includes dev_build_update_available alongside the existing update categories', () => {
    const draft = nodeMuteUpdatesDraft(1, 'edge');
    expect(draft.categories).toEqual([
      'image_update_available', 'node_update_available', 'dev_build_update_available', 'update_started',
    ]);
  });
});
