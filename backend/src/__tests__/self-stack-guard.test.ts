import { describe, it, expect, afterEach, vi } from 'vitest';
import SelfIdentityService from '../services/SelfIdentityService';
import DockerController from '../services/DockerController';
import {
  isSelfStack,
  isSelfStackByIdentity,
  getSelfStackProjectName,
  resolveSelfStackIdentity,
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
  delete process.env.HOSTNAME;
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

  it('falls back to matching the running container against compose labels', async () => {
    const runtimeId = 'a'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject(null);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([
          {
            Id: runtimeId,
            Labels: {
              'com.docker.compose.project': 'renamed-project',
              'com.docker.compose.project.working_dir': '/app/compose/sencho',
            },
          },
        ]),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    expect(await isSelfStack('sencho')).toBe(true);
  });

  it('falls back to the running container compose project label', async () => {
    const runtimeId = 'b'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject(null);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([
          {
            Id: runtimeId,
            Labels: {
              'com.docker.compose.project': 'sencho',
            },
          },
        ]),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    expect(await isSelfStack('sencho')).toBe(true);
  });
});

describe('getSelfStackProjectName', () => {
  it('returns the compose project from SelfIdentityService', async () => {
    stubComposeProject('my-sencho');
    expect(await getSelfStackProjectName()).toBe('my-sencho');
  });
});

describe('resolveSelfStackIdentity + isSelfStackByIdentity', () => {
  it('matches the stack whose name equals the resolved project name', async () => {
    stubComposeProject('sencho');
    const identity = await resolveSelfStackIdentity();
    expect(isSelfStackByIdentity(identity, 'sencho')).toBe(true);
    expect(isSelfStackByIdentity(identity, 'web')).toBe(false);
  });

  it('matches by the container compose project label when the project name is unknown', async () => {
    const runtimeId = 'c'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject(null);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([
          {
            Id: runtimeId,
            Labels: { 'com.docker.compose.project': 'renamed-project' },
          },
        ]),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const identity = await resolveSelfStackIdentity();
    expect(isSelfStackByIdentity(identity, 'renamed-project')).toBe(true);
    expect(isSelfStackByIdentity(identity, 'web')).toBe(false);
  });

  it('matches by the working directory basename inside the compose dir', async () => {
    const runtimeId = 'd'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject(null);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([
          {
            Id: runtimeId,
            Labels: { 'com.docker.compose.project.working_dir': '/app/compose/sencho' },
          },
        ]),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const identity = await resolveSelfStackIdentity();
    expect(isSelfStackByIdentity(identity, 'sencho', '/app/compose')).toBe(true);
  });

  it('does not match a working directory outside the compose dir', async () => {
    const runtimeId = 'g'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject(null);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([
          {
            Id: runtimeId,
            Labels: { 'com.docker.compose.project.working_dir': '/srv/other/sencho' },
          },
        ]),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const identity = await resolveSelfStackIdentity();
    expect(isSelfStackByIdentity(identity, 'sencho', '/app/compose')).toBe(false);
  });

  it('is false when no identity source is available, and not degraded', async () => {
    stubComposeProject(null);
    const identity = await resolveSelfStackIdentity();
    expect(isSelfStackByIdentity(identity, 'sencho')).toBe(false);
    // No source attempted a Docker call, so this is the healthy
    // "not running in Docker" state, not a degradation.
    expect(identity.degraded).toBe(false);
  });

  it('marks the identity degraded when the container list read throws', async () => {
    const runtimeId = 'f'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject('sencho');
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockRejectedValue(new Error('socket unreachable')),
      }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const identity = await resolveSelfStackIdentity();
    // The surviving source still resolves, but the failed probe marks the
    // whole identity degraded so callers refuse to cache it.
    expect(identity.projectName).toBe('sencho');
    expect(identity.labels).toBeNull();
    expect(identity.degraded).toBe(true);
    expect(isSelfStackByIdentity(identity, 'sencho')).toBe(true);
  });

  it('resolves identity with at most one container list read, shared by all stacks', async () => {
    const runtimeId = 'e'.repeat(64);
    process.env.HOSTNAME = runtimeId.slice(0, 12);
    stubComposeProject('sencho');
    const listContainers = vi.fn().mockResolvedValue([]);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({ listContainers }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const identity = await resolveSelfStackIdentity();
    // Reuse the resolved identity across every stack in the request.
    for (const name of ['sencho', 'web', 'db', 'cache']) {
      isSelfStackByIdentity(identity, name, '/app/compose');
    }
    expect(listContainers).toHaveBeenCalledTimes(1);
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
