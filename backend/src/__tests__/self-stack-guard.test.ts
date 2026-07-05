import { describe, it, expect, afterEach, vi } from 'vitest';
import SelfIdentityService from '../services/SelfIdentityService';
import {
  isSelfStack,
  getSelfStackProjectName,
  SELF_STACK_PROTECTED_CODE,
  SELF_STACK_PROTECTED_MESSAGE,
  selfStackProtectedBulkResult,
} from '../helpers/selfStackGuard';

function stubComposeProject(name: string | null) {
  const svc = SelfIdentityService.getInstance();
  vi.spyOn(svc, 'initialize').mockResolvedValue(undefined);
  vi.spyOn(svc, 'getIdentity').mockReturnValue({
    containerId: 'a'.repeat(64),
    containerName: 'sencho',
    composeProjectName: name,
    imageId: 'b'.repeat(64),
    networkNames: [],
    volumeNames: [],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  SelfIdentityService.getInstance().resetForTesting();
});

describe('isSelfStack', () => {
  it('returns true when compose project matches the stack name', async () => {
    stubComposeProject('sencho');
    expect(await isSelfStack('sencho')).toBe(true);
  });

  it('returns false for a different stack name', async () => {
    stubComposeProject('sencho');
    expect(await isSelfStack('web')).toBe(false);
  });

  it('returns false when self identity is unavailable', async () => {
    stubComposeProject(null);
    expect(await isSelfStack('sencho')).toBe(false);
  });
});

describe('getSelfStackProjectName', () => {
  it('returns the compose project from SelfIdentityService', async () => {
    stubComposeProject('my-sencho');
    expect(await getSelfStackProjectName()).toBe('my-sencho');
  });
});

describe('selfStackProtectedBulkResult', () => {
  it('returns a per-stack bulk failure with the protected code', () => {
    const result = selfStackProtectedBulkResult('sencho');
    expect(result).toEqual({
      stackName: 'sencho',
      ok: false,
      error: SELF_STACK_PROTECTED_MESSAGE,
      code: SELF_STACK_PROTECTED_CODE,
    });
  });
});
