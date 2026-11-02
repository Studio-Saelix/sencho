/**
 * The one shared handler for an update blocked by io.sencho.update: it reads the
 * 409 defensively, names the label once, and offers the only place the decision
 * can change (the Compose file, or the editor that opens it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseUpdatePolicyRefusal,
  parseUpdatePolicyRefusalText,
  toastUpdatePolicyRefusal,
} from '@/lib/updatePolicyRefusal';
import { SENCHO_OPEN_STACK_EVENT } from '@/lib/events';

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from '@/components/ui/toast-store';

const body = {
  error: 'Update blocked by io.sencho.update: "db" is set to disabled.',
  code: 'update_policy_blocked',
  serviceName: 'db',
  updatePolicy: { evaluation: 'evaluated', manualDecision: 'block', reason: '"db" is set to disabled.', services: [] },
};

describe('parseUpdatePolicyRefusal', () => {
  it('reads the server sentence, the reason and the service it named', () => {
    expect(parseUpdatePolicyRefusal(body, 409)).toEqual({
      message: 'Update blocked by io.sencho.update: "db" is set to disabled.',
      reason: '"db" is set to disabled.',
      serviceName: 'db',
    });
  });

  it('prefixes a bare reason once, so the label is never repeated', () => {
    const refusal = parseUpdatePolicyRefusal({
      code: 'update_policy_blocked',
      error: 'a service is not eligible',
      updatePolicy: { reason: 'a service is not eligible' },
    }, 409);
    expect(refusal?.message).toBe('Update blocked by io.sencho.update: a service is not eligible.');
  });

  it('falls back to null for a body that is not a refusal, so the caller uses its generic copy', () => {
    expect(parseUpdatePolicyRefusal(body, 500)).toBeNull();
    expect(parseUpdatePolicyRefusal({ code: 'policy_blocked', error: 'x' }, 409)).toBeNull();
    expect(parseUpdatePolicyRefusal({ code: 'update_policy_blocked' }, 409)).toBeNull();
    expect(parseUpdatePolicyRefusal(null, 409)).toBeNull();
    expect(parseUpdatePolicyRefusal([], 409)).toBeNull();
  });

  it('parses raw text and returns null for a body that is not JSON', () => {
    expect(parseUpdatePolicyRefusalText(JSON.stringify(body), 409)?.serviceName).toBe('db');
    expect(parseUpdatePolicyRefusalText('<html>bad gateway</html>', 409)).toBeNull();
  });
});

describe('toastUpdatePolicyRefusal', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it('offers the editor outside it', () => {
    const refusal = parseUpdatePolicyRefusal(body, 409);
    expect(refusal).not.toBeNull();
    toastUpdatePolicyRefusal(refusal!, { nodeId: 2, stackName: 'web', inEditor: false });
    const [message, options] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toBe(body.error);
    expect(options?.action?.label).toBe('Open stack editor');

    const opened = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, opened);
    options?.action?.onClick();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 2, stackName: 'web', destination: 'editor' });
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, opened);
  });

  it('opens the Compose file in place inside the editor', () => {
    const openComposeFile = vi.fn();
    const refusal = parseUpdatePolicyRefusal(body, 409)!;
    toastUpdatePolicyRefusal(refusal, { nodeId: 2, stackName: 'web', inEditor: true, onOpenComposeFile: openComposeFile });
    const [, options] = vi.mocked(toast.error).mock.calls[0];
    expect(options?.action?.label).toBe('Open Compose file');
    options?.action?.onClick();
    expect(openComposeFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the editor handoff when the editor offers no Compose-file handler', () => {
    const refusal = parseUpdatePolicyRefusal(body, 409)!;
    toastUpdatePolicyRefusal(refusal, { nodeId: 2, stackName: 'web', inEditor: true });
    const opened = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, opened);
    vi.mocked(toast.error).mock.calls[0][1]?.action?.onClick();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 2, stackName: 'web', destination: 'editor' });
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, opened);
  });

  it('sends no handoff when the caller has no node to bind to', () => {
    const refusal = parseUpdatePolicyRefusal(body, 409)!;
    toastUpdatePolicyRefusal(refusal, { nodeId: null, stackName: 'web', inEditor: false });
    const opened = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, opened);
    vi.mocked(toast.error).mock.calls[0][1]?.action?.onClick();
    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, opened);
  });
});
