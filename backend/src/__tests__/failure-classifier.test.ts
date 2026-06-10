import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../services/updateGuard/failureClassifier';
import type { FailureReason } from '../services/updateGuard/types';

describe('classifyFailure', () => {
  const cases: Array<{ name: string; message: string; reason: FailureReason }> = [
    {
      name: 'container crash sentinel',
      message: 'CONTAINER_CRASHED\nExit Code: 137\nContainer exited after deployment. Check container logs for details.',
      reason: 'container_exited',
    },
    {
      name: 'idle stall sentinel',
      message: 'STACK_STALLED_OUTPUT: no output for 600s',
      reason: 'unknown',
    },
    {
      name: 'docker daemon down (message)',
      message: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      reason: 'node_unreachable',
    },
    {
      name: 'docker desktop connect error',
      message: 'error during connect: this error may indicate that the docker daemon is not running',
      reason: 'node_unreachable',
    },
    {
      name: 'required variable missing',
      message: 'error while interpolating services.web.environment.TOKEN: required variable REQ_TOKEN is missing a value: must be provided',
      reason: 'env_missing',
    },
    {
      name: 'variable not set (logfmt warning escalated)',
      message: 'level=warning msg="The \\"DB_HOST\\" variable is not set. Defaulting to a blank string."',
      reason: 'env_missing',
    },
    {
      name: 'env file not found',
      message: "env file /compose/app/.env not found: stat /compose/app/.env: no such file or directory",
      reason: 'env_missing',
    },
    {
      name: 'pull access denied',
      message: 'Error response from daemon: pull access denied for ghost/missing, repository does not exist or may require docker login',
      reason: 'image_pull_failed',
    },
    {
      name: 'manifest unknown',
      message: 'manifest unknown: manifest unknown',
      reason: 'image_pull_failed',
    },
    {
      name: 'registry rate limited',
      message: 'toomanyrequests: You have reached your pull rate limit.',
      reason: 'image_pull_failed',
    },
    {
      name: 'port already allocated',
      message: 'Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated',
      reason: 'port_conflict',
    },
    {
      name: 'address already in use',
      message: 'listen tcp4 0.0.0.0:443: bind: address already in use',
      reason: 'port_conflict',
    },
    {
      name: 'windows ports not available',
      message: 'ports are not available: exposing port TCP 0.0.0.0:5432 -> 0.0.0.0:0',
      reason: 'port_conflict',
    },
    {
      name: 'bind source missing',
      message: 'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /srv/missing',
      reason: 'bind_path_missing',
    },
    {
      name: 'permission denied',
      message: 'open /compose/app/data: permission denied',
      reason: 'permission_denied',
    },
    {
      name: 'unhealthy dependency',
      message: 'dependency failed to start: container app-db-1 is unhealthy',
      reason: 'healthcheck_failed',
    },
    {
      name: 'dependency exited',
      message: 'dependency failed to start: container app-db-1 exited (1)',
      reason: 'dependency_unavailable',
    },
    {
      name: 'external network missing',
      message: 'network proxy_net declared as external, but could not be found',
      reason: 'dependency_unavailable',
    },
    {
      name: 'yaml syntax error',
      message: 'yaml: line 14: mapping values are not allowed in this context',
      reason: 'compose_render_failed',
    },
    {
      name: 'undefined volume',
      message: 'service "web" refers to undefined volume data: invalid compose project',
      reason: 'compose_render_failed',
    },
    {
      name: 'unmatched output falls back to unknown',
      message: 'something completely unexpected happened',
      reason: 'unknown',
    },
  ];

  it.each(cases)('classifies $name as $reason', ({ message, reason }) => {
    const result = classifyFailure(message);
    expect(result.reason).toBe(reason);
    expect(result.label.length).toBeGreaterThan(0);
    expect(result.suggestion.length).toBeGreaterThan(0);
  });

  it('short-circuits to node_unreachable when the route flags a dead daemon', () => {
    expect(classifyFailure('arbitrary text', { dockerUnavailable: true }).reason).toBe('node_unreachable');
  });

  it('prefers env_missing over compose_render_failed when a render fails on a missing variable', () => {
    const result = classifyFailure(
      'invalid compose project: required variable DB_PASS is missing a value',
    );
    expect(result.reason).toBe('env_missing');
  });

  it('prefers the crash sentinel over any other pattern in the same output', () => {
    const result = classifyFailure(
      'CONTAINER_CRASHED\nExit Code: 1\nport is already allocated',
    );
    expect(result.reason).toBe('container_exited');
  });

  it('classifies the underlying cause of a rolled-back update from its message', () => {
    // ComposeRollbackError copies the original error message, so the route can
    // pass getErrorMessage(error) unchanged for wrapped failures.
    const causeMessage = 'pull access denied for private/app';
    expect(classifyFailure(causeMessage).reason).toBe('image_pull_failed');
  });

  it('always returns a classification (total over arbitrary input)', () => {
    for (const message of ['', '   ', 'x'.repeat(10_000)]) {
      const result = classifyFailure(message);
      expect(result.reason).toBeDefined();
      expect(result.label).toBeDefined();
      expect(result.suggestion).toBeDefined();
    }
  });
});
