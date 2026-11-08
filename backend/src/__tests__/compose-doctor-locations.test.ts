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

  it('leaves every field unlocated when a later layer cannot be parsed', async () => {
    writeStack('doctor-unparsable', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:latest\n',
      'compose.override.yaml': 'services: [\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-unparsable');
    // The unparsed override could declare either field, so neither origin is
    // defensible even though the base file is readable.
    const image = locateFinding(project, hit('image-latest', { service: 'api', sourcePath: 'api' }));
    expect(image).toBeUndefined();
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

  it('reports the override file and its own index for a port only it declares', async () => {
    writeStack('doctor-port-index', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "9000:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-index');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '9000/tcp' },
    }));
    expect(port).toMatchObject({ file: 'compose.override.yaml', line: 4, path: 'services.api.ports[0]' });
  });

  it('refuses a port declared identically in the base and the override', async () => {
    writeStack('doctor-port-duplicate', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-duplicate');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    // Compose dedupes the identical publication, but both files authored it:
    // exactly one item must match before the location may name a file.
    expect(port).toBeUndefined();
  });

  it('refuses an unquoted base port and a quoted override of the same value', async () => {
    writeStack('doctor-port-duplicate-quoting', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - 22:22\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "22:22"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-duplicate-quoting');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '22/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('refuses a port declared in long form in both layers', async () => {
    writeStack('doctor-port-duplicate-long', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - target: 80\n        published: "8080"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-duplicate-long');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('refuses the same duplicated port for a port-conflict hit', async () => {
    writeStack('doctor-port-conflict-duplicate', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-conflict-duplicate');
    const conflict = locateFinding(project, hit('port-conflict-node', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(conflict).toBeUndefined();
  });

  it('refuses the same duplicated port for a subjectless sensitive exposure', async () => {
    writeStack('doctor-sensitive-duplicate', {
      'compose.yaml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
      'compose.override.yaml': 'services:\n  db:\n    ports:\n      - "5432:5432"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-sensitive-duplicate');
    const model = {
      services: [{
        name: 'db',
        ports: [{ startPort: 5432, endPort: 5432, hostIp: '', protocol: 'tcp' }],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('sensitive-service-broad-exposure', {
      service: 'db', sourcePath: 'db',
    }), model);
    expect(broad).toBeUndefined();
  });

  it('refuses a port range declared in both layers', async () => {
    writeStack('doctor-port-duplicate-range', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080-8081:80-81"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "8080-8081:80-81"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-duplicate-range');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080-8081/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('refuses a port location when another project layer has a truncated alias graph', async () => {
    const overrideLines = ['x-0: &a0 [true]'];
    for (let level = 1; level < 20; level += 1) overrideLines.push(`x-${level}: &a${level} [*a${level - 1}]`);
    writeStack('doctor-port-alias-layer', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': `${overrideLines.join('\n')}\n`,
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-alias-layer');
    expect(project.files.find(file => file.file === 'compose.override.yaml')?.state).toBe('parse-failed');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('refuses a duplicate port supplied through a root-level merge in the override', async () => {
    writeStack('doctor-port-root-merge', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': [
        'x-ovr: &ovr',
        '  services:',
        '    api:',
        '      ports:',
        '        - "8080:80"',
        '<<: *ovr',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-root-merge');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('refuses a port location when an earlier COMPOSE_FILE layer cannot be parsed', async () => {
    writeStack('doctor-port-earlier-unparsed', {
      '.env': 'COMPOSE_FILE=compose.yaml:broken.yaml:more.yaml\n',
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n',
      'broken.yaml': 'services: [\n',
      'more.yaml': 'services:\n  api:\n    ports:\n      - "8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-earlier-unparsed');
    expect(project.files.find(file => file.file === 'broken.yaml')?.state).toBe('parse-failed');
    const port = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }));
    expect(port).toBeUndefined();
  });

  it('locates the broad publication, not a loopback override on the same host port', async () => {
    writeStack('doctor-port-broad', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "127.0.0.1:8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-broad');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
          { startPort: 8080, endPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(broad).toMatchObject({ file: 'compose.yaml', line: 5 });
    const conflict = locateFinding(project, hit('port-conflict-node', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    // Two same-layer matches on distinct interfaces cannot be told apart by a
    // subject that carries no interface: refuse rather than guess.
    expect(conflict).toBeUndefined();
  });

  it('distinguishes a dynamic publication by its container target', async () => {
    writeStack('doctor-port-dynamic', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "127.0.0.1::80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-dynamic');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 0, endPort: 0, hostIp: '', protocol: 'tcp', dynamic: true, targetStartPort: 80, targetEndPort: 80 },
          { startPort: 0, endPort: 0, hostIp: '127.0.0.1', protocol: 'tcp', dynamic: true, targetStartPort: 80, targetEndPort: 80 },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: 'dynamic/tcp' },
    }), model);
    expect(broad).toMatchObject({ file: 'compose.yaml', line: 5 });
  });

  it('matches the long-form equivalent of a short broad port and ignores a loopback long form', async () => {
    writeStack('doctor-port-long', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': [
        'services:',
        '  api:',
        '    ports:',
        '      - target: 80',
        '        published: "8080"',
        '        host_ip: 127.0.0.1',
        '        protocol: tcp',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-long');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
          { startPort: 8080, endPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(broad).toMatchObject({ file: 'compose.yaml', line: 5 });
  });

  it('refuses a port location when a later interpolated publication could resolve to it', async () => {
    writeStack('doctor-port-interpolated', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "${ADMIN_PORT}:81"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-interpolated');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
          { startPort: 9090, endPort: 9090, hostIp: '', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(broad).toBeUndefined();
  });

  it('matches an IPv6 broad UDP port range in long form', async () => {
    writeStack('doctor-port-udp-range', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    image: nginx:1',
        '    ports:',
        '      - target: "5000-5001"',
        '        published: "5000-5001"',
        '        host_ip: "::"',
        '        protocol: udp',
        '',
      ].join('\n'),
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-udp-range');
    const model = {
      services: [{
        name: 'api',
        ports: [{ startPort: 5000, endPort: 5001, hostIp: '::', protocol: 'udp' }],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '5000-5001/udp' },
    }), model);
    expect(broad).toMatchObject({ file: 'compose.yaml', line: 5 });
  });

  it('does not attribute a top-level network to an extends base', async () => {
    writeStack('doctor-top-level-extends', {
      'compose.yaml': [
        'services:',
        '  api:',
        '    extends:',
        '      file: base.yml',
        '      service: base',
        'networks:',
        '  edge:',
        '    external: true',
        '',
      ].join('\n'),
      'base.yml': 'services:\n  base:\n    image: nginx:1\nnetworks:\n  edge:\n    external: true\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-top-level-extends');
    const network = locateFinding(project, hit('external-network-missing', {
      sourcePath: 'networks.edge',
    }));
    expect(network).toMatchObject({ file: 'compose.yaml', line: 7 });
  });

  it('refuses a tagged top-level network declaration', async () => {
    writeStack('doctor-top-level-tag', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\nnetworks:\n  edge: !reset {}\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-top-level-tag');
    const network = locateFinding(project, hit('external-network-missing', {
      sourcePath: 'networks.edge',
    }));
    expect(network).toBeUndefined();
  });

  it('locates a sensitive-service broad exposure without a subject only when one publication matches', async () => {
    writeStack('doctor-sensitive-port', {
      'compose.yaml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
      'compose.override.yaml': 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-sensitive-port');
    const model = {
      services: [{
        name: 'db',
        ports: [
          { startPort: 5432, endPort: 5432, hostIp: '', protocol: 'tcp' },
          { startPort: 5432, endPort: 5432, hostIp: '127.0.0.1', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('sensitive-service-broad-exposure', {
      service: 'db', sourcePath: 'db',
    }), model);
    expect(broad).toMatchObject({ file: 'compose.yaml', line: 5 });
  });

  it('refuses a subjectless sensitive exposure when two broad publications survive', async () => {
    writeStack('doctor-sensitive-two', {
      'compose.yaml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
      'compose.override.yaml': 'services:\n  db:\n    ports:\n      - "6379:6379"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-sensitive-two');
    const model = {
      services: [{
        name: 'db',
        ports: [
          { startPort: 5432, endPort: 5432, hostIp: '', protocol: 'tcp' },
          { startPort: 6379, endPort: 6379, hostIp: '', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('sensitive-service-broad-exposure', {
      service: 'db', sourcePath: 'db',
    }), model);
    expect(broad).toBeUndefined();
  });

  it('refuses two surviving publications with the same host port and different targets', async () => {
    writeStack('doctor-port-targets', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "8080:80"\n',
      'compose.override.yaml': 'services:\n  api:\n    ports:\n      - "8080:81"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-targets');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(broad).toBeUndefined();
  });

  it('never reads an aliased port item as a dynamic publication', async () => {
    writeStack('doctor-port-alias', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports:\n      - "80"\n',
      'compose.override.yaml': 'x-port: &port "8080:80"\nservices:\n  api:\n    ports:\n      - *port\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-alias');
    const model = {
      services: [{
        name: 'api',
        ports: [
          { startPort: 0, endPort: 0, hostIp: '', protocol: 'tcp', dynamic: true, targetStartPort: 80, targetEndPort: 80 },
          { startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' },
        ],
      }],
    } as unknown as EffectiveModel;
    const dynamic = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: 'dynamic/tcp' },
    }), model);
    // The alias could still resolve to a dynamic publication, so no link is
    // defensible; the override's concrete 8080 must never stand in for it.
    expect(dynamic).toBeUndefined();
    const concrete = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(concrete).toBeUndefined();
  });

  it('refuses a location when the field itself carries !override', async () => {
    writeStack('doctor-port-tag', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    ports: !override\n      - "8080:80"\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-port-tag');
    const model = {
      services: [{
        name: 'api',
        ports: [{ startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' }],
      }],
    } as unknown as EffectiveModel;
    const broad = locateFinding(project, hit('port-exposed-all-interfaces', {
      service: 'api', sourcePath: 'api', subject: { kind: 'port', key: '8080/tcp' },
    }), model);
    expect(broad).toBeUndefined();
  });

  it('refuses an env-file subject no authored entry names', async () => {
    writeStack('doctor-env-file-miss', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    env_file:\n      - a.env\n',
      'a.env': 'A=1\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-file-miss');
    const missing = locateFinding(project, hit('env-file-missing', {
      service: 'api', sourcePath: 'b.env',
    }));
    expect(missing).toBeUndefined();
  });

  it('refuses an env-file path declared in both layers', async () => {
    writeStack('doctor-env-file-duplicate', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    env_file:\n      - gone.env\n',
      'compose.override.yaml': 'services:\n  api:\n    env_file:\n      - gone.env\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-file-duplicate');
    const missing = locateFinding(project, hit('env-file-missing', {
      service: 'api', sourcePath: 'gone.env',
    }));
    expect(missing).toBeUndefined();
  });

  it('locates a long-form env-file entry at its path value', async () => {
    writeStack('doctor-env-file-long', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    env_file:\n      - path: gone.env\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-file-long');
    const missing = locateFinding(project, hit('env-file-missing', {
      service: 'api', sourcePath: 'gone.env',
    }));
    expect(missing).toMatchObject({
      file: 'compose.yaml', line: 5, column: 15, path: 'services.api.env_file[0]',
    });
  });

  it('refuses an env-file path declared at different indexes in both layers', async () => {
    writeStack('doctor-env-file-duplicate-index', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    env_file:\n      - gone.env\n',
      'compose.override.yaml': 'services:\n  api:\n    env_file:\n      - b.env\n      - gone.env\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-file-duplicate-index');
    const missing = locateFinding(project, hit('env-file-missing', {
      service: 'api', sourcePath: 'gone.env',
    }));
    expect(missing).toBeUndefined();
  });

  it('locates a unique env-file entry even when its index differs across layers', async () => {
    writeStack('doctor-env-file-index', {
      'compose.yaml': 'services:\n  api:\n    image: nginx:1\n    env_file:\n      - a.env\n      - gone.env\n',
      'compose.override.yaml': 'services:\n  api:\n    env_file:\n      - b.env\n',
    });
    const project = await buildAuthoredProject(nodeId, 'doctor-env-file-index');
    const missing = locateFinding(project, hit('env-file-missing', {
      service: 'api', sourcePath: 'gone.env',
    }));
    expect(missing).toMatchObject({ file: 'compose.yaml', line: 6, path: 'services.api.env_file[1]' });
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
