/**
 * buildEffectiveServiceModel: turns `docker compose config --format json`
 * output into the per-service facts (declared image, build presence,
 * expected replicas, dependencies, healthcheck) that service-scoped update
 * and restore key off of. Fail-closed is the critical property: a render
 * failure must leave `renderable: false` with no services, never a
 * root-file fallback.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ComposeService } from '../services/ComposeService';
import { buildEffectiveServiceModel } from '../services/effectiveServiceModel';

const ENV_SECRET = 'env-secret-9d4a-value';

function stubRender(rendered: string | null, stderr = '') {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false }),
  } as unknown as ComposeService);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildEffectiveServiceModel', () => {
  it('extracts declared image, dependsOn, and healthcheck for an image-only service', async () => {
    stubRender(JSON.stringify({
      services: {
        web: {
          image: 'nginx:latest',
          depends_on: { db: { condition: 'service_healthy', required: true } },
          healthcheck: { test: ['CMD', 'true'] },
        },
        db: { image: 'postgres:16' },
      },
    }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    expect(result.renderable).toBe(true);
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services).toEqual([
      { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: ['db'], hasHealthcheck: true },
      { name: 'db', declaredImage: 'postgres:16', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);
  });

  it('flags hasBuild for a build-backed service, including image+build', async () => {
    stubRender(JSON.stringify({
      services: {
        api: { build: { context: '.' } },
        worker: { image: 'app:latest', build: { context: '.' } },
      },
    }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services[0]).toMatchObject({ name: 'api', declaredImage: null, hasBuild: true });
    expect(result.services[1]).toMatchObject({ name: 'worker', declaredImage: 'app:latest', hasBuild: true });
  });

  it('reads expectedReplicas from the top-level scale field, deploy.replicas, or defaults to 1', async () => {
    stubRender(JSON.stringify({
      services: {
        scaled: { image: 'a', scale: 3 },
        deployed: { image: 'b', deploy: { replicas: 2 } },
        zeroed: { image: 'c', scale: 0 },
        unset: { image: 'd' },
      },
    }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services.map(s => s.expectedReplicas)).toEqual([3, 2, 0, 1]);
  });

  it('treats a disabled healthcheck as none', async () => {
    stubRender(JSON.stringify({
      services: { web: { image: 'a', healthcheck: { disable: true } } },
    }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services[0].hasHealthcheck).toBe(false);
  });

  it('parses depends_on given in the short list form', async () => {
    stubRender(JSON.stringify({
      services: { web: { image: 'a', depends_on: ['db', 'cache'] } },
    }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services[0].dependsOn).toEqual(['db', 'cache']);
  });

  it('fails closed with a redacted error and no services when the render errors', async () => {
    stubRender(null, `error: the "${ENV_SECRET}" variable is not set`);
    const result = await buildEffectiveServiceModel(1, 'mystack');
    expect(result.renderable).toBe(false);
    if (result.renderable) throw new Error('expected not renderable');
    expect(result.code).toBe('effective_model_render_failed');
    expect(result.error).not.toContain(ENV_SECRET);
  });

  it('fails closed when the rendered output is not valid JSON', async () => {
    stubRender('this is not json {');
    const result = await buildEffectiveServiceModel(1, 'mystack');
    expect(result.renderable).toBe(false);
    if (result.renderable) throw new Error('expected not renderable');
    expect(result.code).toBe('effective_model_render_failed');
  });

  it('fails closed and redacts the message when renderConfig throws (docker unavailable)', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockRejectedValue(new Error(`spawn failed: password=${ENV_SECRET}`)),
    } as unknown as ComposeService);
    const result = await buildEffectiveServiceModel(1, 'mystack');
    expect(result.renderable).toBe(false);
    if (result.renderable) throw new Error('expected not renderable');
    expect(result.code).toBe('effective_model_render_failed');
    expect(result.error).not.toContain(ENV_SECRET);
  });

  it('yields an empty service list for a garbage or empty rendered model', async () => {
    stubRender(JSON.stringify({ services: {} }));
    const result = await buildEffectiveServiceModel(1, 'mystack');
    if (!result.renderable) throw new Error('expected renderable');
    expect(result.services).toEqual([]);
  });
});
