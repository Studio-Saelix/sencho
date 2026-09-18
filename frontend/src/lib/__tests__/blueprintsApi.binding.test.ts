import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch } from '@/lib/api';
import { listDirectGitSourceOptions } from '@/lib/blueprintsApi';
import { liveRevision } from '@/__tests__/gitopsFixtures';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('listDirectGitSourceOptions', () => {
  it('keeps live Direct sources and drops Blueprint-claimed rows', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes([
      {
        stack_name: 'web',
        repo_url: 'https://github.com/example/web.git',
        branch: 'main',
        gitopsRevision: liveRevision({ targetMode: 'direct', applicationId: 'app-web' }),
      },
      {
        stack_name: 'claimed',
        repo_url: 'https://github.com/example/claimed.git',
        branch: 'main',
        gitopsRevision: liveRevision({
          targetMode: 'blueprint',
          applicationId: 'app-claimed',
          stackName: null,
          blueprintId: 9,
        }),
      },
      {
        stack_name: 'orphan',
        repo_url: 'https://github.com/example/orphan.git',
        branch: 'main',
      },
    ]));

    await expect(listDirectGitSourceOptions()).resolves.toEqual([
      {
        applicationId: 'app-web',
        stackName: 'web',
        repoUrl: 'https://github.com/example/web.git',
        ref: 'main',
      },
    ]);
    expect(apiFetch).toHaveBeenCalledWith('/git-sources', { localOnly: true });
  });
});
