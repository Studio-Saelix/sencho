/**
 * The published API reference lists every recovery route.
 *
 * Nothing else checks docs/openapi.yaml against the router, so a route added
 * without a spec entry reaches production undocumented. This reads the router
 * itself and the spec, so a new route fails here until it is described.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let routerRoutes: string[];

/** `/points/:pointId/restore` and `/points/{pointId}/restore` compare as one shape. */
const shapeOf = (route: string): string => route.replace(/:[A-Za-z]+|\{[A-Za-z]+\}/g, '{}');

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const { recoveryRouter } = await import('../routes/recovery');
  const layers = (recoveryRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  }).stack;
  routerRoutes = layers.flatMap((layer) => (layer.route
    ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} /api/recovery${shapeOf(layer.route!.path)}`)
    : []));
});

afterAll(() => cleanupTestDb(tmpDir));

describe('docs/openapi.yaml', () => {
  it('describes every route the recovery router serves', () => {
    const spec = parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = Object.entries(spec.paths)
      .filter(([route]) => route.startsWith('/api/recovery'))
      .flatMap(([route, operations]) => Object.keys(operations)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${shapeOf(route)}`));
    expect(routerRoutes.length).toBeGreaterThan(10);
    expect(routerRoutes.filter((route) => !documented.includes(route))).toEqual([]);
    expect(documented.filter((route) => !routerRoutes.includes(route))).toEqual([]);
  });

  it('names the three overwrite routes', () => {
    expect(routerRoutes).toEqual(expect.arrayContaining([
      'POST /api/recovery/points/{}/overwrite/preview',
      'POST /api/recovery/points/{}/overwrite',
      'POST /api/recovery/restores/{}/resolve',
    ]));
  });

  it('lists every recovery error class the router can answer', async () => {
    const spec = parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/openapi.yaml'), 'utf8')) as {
      components: { schemas: { RecoveryError: { properties: { errorClass: { enum: string[] } } } } };
    };
    const { ERROR_STATUS } = await import('../routes/recovery');
    const documented = spec.components.schemas.RecoveryError.properties.errorClass.enum;
    expect(Object.keys(ERROR_STATUS).filter((name) => !documented.includes(name))).toEqual([]);
  });
});
