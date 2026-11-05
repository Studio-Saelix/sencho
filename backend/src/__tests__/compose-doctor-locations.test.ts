import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { buildAuthoredProject, locateFinding } from '../services/composeSource';
import { normalizeDoctorHit } from '../services/assurance/finding';
import { getAssuranceRule } from '../services/assurance/ruleRegistry';
import type { RuleHit } from '../services/preflight/types';
import type { EffectiveModel } from '../services/preflight/effectiveModel';

let tmpDir: string;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterAll(() => cleanupTestDb(tmpDir));

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(process.env.COMPOSE_DIR as string, stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

function hit(ruleId: RuleHit['ruleId'], overrides: Partial<RuleHit> = {}): RuleHit {
  return { ruleId, severity: 'warning', title: 't', message: 'm', ...overrides };
}

describe('Compose Doctor authored locations', () => {
  it('locates each field class on the file the operator must edit', async () => {
    writeStack('doctor-locations', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:latest',
        '    privileged: true',
        '    ports:',
        '      - "8080:80"',
        '    volumes:',
        '      - ./data:/data',
        '  worker:',
        '    image: busybox:1',
        'networks:',
        '  edge:',
        '    external: true',
        '',
      ].join('\n'),
      'compose.override.yaml': [
        'services:',
        '  api:',
        '    image: redis:7',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-locations');
    const model = { services: [{ name: 'api', image: 'redis:7' }] } as unknown as EffectiveModel;
    const image = locateFinding(project, hit('image-latest', { service: 'api', sourcePath: 'api' }), model);
    expect(image).toMatchObject({ file: 'compose.override.yaml', line: 3 });
    const privileged = locateFinding(project, hit('privileged', { service: 'api', sourcePath: 'api' }));
    expect(privileged).toMatchObject({ file: 'compose.yaml', line: 4 });
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(port).toMatchObject({ file: 'compose.yaml', line: 6, column: 9 });
    const bind = locateFinding(project, hit('bind-path-missing', {
      service: 'api', sourcePath: '/data', subject: { kind: 'bind', key: '/data' },
    }));
    expect(bind).toMatchObject({ file: 'compose.yaml', line: 8 });
    const absent = locateFinding(project, hit('no-healthcheck', { service: 'api', sourcePath: 'api' }));
    // api is declared in both layers, so the declaration point is ambiguous.
    expect(absent).toBeUndefined();
    const network = locateFinding(project, hit('external-network-missing', { sourcePath: 'networks.edge' }));
    expect(network).toMatchObject({ file: 'compose.yaml', line: 12 });
  });

  it('leaves unrelated findings unlocated when an additional layer cannot be parsed', async () => {
    writeStack('doctor-unparsable', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:latest\n',
      'compose.override.yaml': 'services: [\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-unparsable');
    const image = locateFinding(project, hit('image-latest', { service: 'api', sourcePath: 'api' }));
    expect(image).toMatchObject({ file: 'compose.yaml', line: 3 });
    const privileged = locateFinding(project, hit('privileged', { service: 'api', sourcePath: 'api' }));
    expect(privileged).toBeUndefined();
  });

  it('locates our own parse failure for render-failed', async () => {
    writeStack('doctor-render-failed', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n',
      'compose.override.yaml': 'services: [\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-render-failed');
    expect(locateFinding(project, hit('render-failed', { severity: 'blocker' }))).toMatchObject({
      file: 'compose.override.yaml', line: 2,
    });
  });

  it('locates the authored environment key for env-literal-dollar in map and list form', async () => {
    writeStack('doctor-env-key', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    environment:',
        '      API_TOKEN: "abc$def"',
        '  worker:',
        '    image: busybox:1',
        '    environment:',
        '      - "WORKER_TOKEN=abc$def"',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-key');
    const mapHit = locateFinding(project, hit('env-literal-dollar', { service: 'api', sourcePath: 'API_TOKEN' }));
    expect(mapHit).toMatchObject({ file: 'compose.yaml', line: 5 });
    const listHit = locateFinding(project, hit('env-literal-dollar', { service: 'worker', sourcePath: 'WORKER_TOKEN' }));
    expect(listHit).toMatchObject({ file: 'compose.yaml', line: 9 });
  });

  it('reports the winning layer and its own index for a moved port item', async () => {
    writeStack('doctor-port-index', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n      - "9000:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "9000:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-index');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '9000/tcp' },
    }));
    expect(port).toMatchObject({ file: 'compose.override.yaml', line: 4, path: 'services.api.ports[0]' });
  });

  it('never carries an interpolated canary in the model JSON, the finding, or the wire', async () => {
    const canary = 'CANARY_SECRET_VALUE_DO_NOT_LEAK';
    writeStack('doctor-canary', {
      'compose.yaml': `services:\n  api:\n    image: \${${canary}}\n    labels:\n      token: \${${canary}}\n`,
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-canary');
    expect(JSON.stringify(project)).not.toContain(canary);
    const rule = getAssuranceRule('image-latest')!;
    const finding = normalizeDoctorHit(
      nodeId, 'doctor-canary', hit('image-latest', { service: 'api', sourcePath: 'api' }), rule,
      locateFinding(project, hit('image-latest', { service: 'api', sourcePath: 'api' })) ?? undefined,
    );
    expect(JSON.stringify(finding)).not.toContain(canary);
    expect(finding.location?.file).toBeUndefined();
  });
});
