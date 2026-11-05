import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildBootstrapPlan, canonicalJson, formatPlanText, planDigest } from '../services/nodeBootstrap/planBuilder';
import { makeAgentDir, makeComposeDir, makeFacts } from './__helpers__/bootstrapFacts';
import type { BootstrapFacts, BootstrapPlan, BootstrapPlanStep } from '../services/nodeBootstrap/types';

const NOW = 1_762_300_000_000;

function planFor(facts: BootstrapFacts, caPem: string | null = null): BootstrapPlan {
  return buildBootstrapPlan({
    facts,
    targetName: 'media-server',
    hubUrl: 'https://sencho.example.com',
    caPem,
    now: NOW,
  });
}

function allSteps(plan: BootstrapPlan): BootstrapPlanStep[] {
  return plan.stages.flatMap((stage) => stage.steps);
}

describe('bootstrap plan builder', () => {
  it('keeps both directories out of the mutating steps when they already exist and are empty', () => {
    const facts = makeFacts({
      composeDir: { stackCount: 3, stackNames: ['media', 'tools', 'web'] },
      agentDir: {
        exists: true,
        isDirectory: true,
        realPath: '/opt/sencho-agent',
        writableByUser: true,
        entries: [],
        readableByUser: true,
      },
    });
    const plan = planFor(facts);
    const skippedIds = plan.skipped.map((entry) => entry.id);
    expect(skippedIds).toContain('compose_dir');
    expect(skippedIds).toContain('agent_dir');
    expect(plan.skipped.find((entry) => entry.id === 'compose_dir')?.reason).toContain('3 stacks');
    expect(plan.stages.find((stage) => stage.id === 'compose_dir')).toBeUndefined();
    expect(plan.stages.find((stage) => stage.id === 'agent_dir')).toBeUndefined();
    expect(plan.paths.composeDir.created).toBe(false);
    expect(plan.paths.agentDir.created).toBe(false);
  });

  it('creates a missing Compose directory with an explicit mode, owner and privilege', () => {
    const facts = makeFacts({
      composeDir: { exists: false, isDirectory: false, realPath: '/opt/docker/sencho', parentWritableByUser: true },
      agentDir: makeAgentDir(),
    });
    const stage = planFor(facts).stages.find((entry) => entry.id === 'compose_dir');
    expect(stage).toBeDefined();
    const [step] = stage!.steps;
    expect(step.effect).toBe('directory-create');
    expect(step.privilege).toBe('user');
    expect(step.target).toMatchObject({ path: '/opt/docker/sencho', mode: '0755', owner: 'ubuntu', group: 'ubuntu' });
    expect(step.command).toBe("install -d -m 0755 -o 'ubuntu' -g 'ubuntu' -- '/opt/docker/sencho'");
  });

  it('uses sudo when the parent is not writable by the SSH user', () => {
    const facts = makeFacts({
      user: { name: 'ubuntu', uid: 1000, group: 'ubuntu', isRoot: false, sudoNonInteractive: true },
      composeDir: { exists: false, isDirectory: false, parentWritableByUser: false, realPath: '/srv/stacks' },
    });
    const step = allSteps(planFor(facts)).find((entry) => entry.id === 'create-compose-dir');
    expect(step?.privilege).toBe('sudo');
    expect(step?.command).toContain('sudo -n install -d');
  });

  it('creates the agent directory with 0700 and writes the three files under it', () => {
    const facts = makeFacts({ agentDir: { exists: false, isDirectory: false, parentWritableByUser: true } });
    const plan = planFor(facts);
    const create = allSteps(plan).find((entry) => entry.id === 'create-agent-dir');
    expect(create?.target?.mode).toBe('0700');
    const files = allSteps(plan).filter((entry) => entry.effect === 'file-write' && entry.file);
    const paths = files.map((entry) => entry.file?.path);
    expect(paths).toContain('/opt/sencho-agent/compose.yaml');
    expect(paths).toContain('/opt/sencho-agent/sencho-bootstrap.json');
    expect(files.find((entry) => entry.file?.path.endsWith('compose.yaml'))?.file?.mode).toBe('0600');
    expect(files.find((entry) => entry.file?.path.endsWith('sencho-bootstrap.json'))?.file?.mode).toBe('0600');
    expect(files.find((entry) => entry.file?.path.endsWith('compose.yaml'))?.file?.content).toContain('{{SENCHO_ENROLL_TOKEN}}');
    expect(files.find((entry) => entry.file?.path.endsWith('sencho-bootstrap.json'))?.file?.content).toContain('"project": "sencho-agent"');
  });

  it('writes the CA next to the compose file when the hub uses native TLS', () => {
    const plan = planFor(makeFacts(), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const ca = allSteps(plan).find((entry) => entry.file?.path.endsWith('sencho-hub-ca.pem'));
    expect(ca?.file?.mode).toBe('0644');
    const compose = allSteps(plan).find((entry) => entry.file?.path.endsWith('compose.yaml'));
    expect(compose?.file?.content).toContain('./sencho-hub-ca.pem');
  });

  it('plans the repository, packages and service only when they are missing or stopped', () => {
    const clean = planFor(makeFacts());
    expect(clean.stages.map((stage) => stage.id)).not.toContain('docker_repository');
    expect(clean.stages.map((stage) => stage.id)).not.toContain('docker_packages');
    expect(clean.skipped.map((entry) => entry.id)).toContain('docker_service');

    const bare = planFor(makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, serviceActive: false, serviceEnabled: false, socketAccess: 'none' },
      repo: { dockerSourceConfigured: false, keyringPresent: false },
      packages: [
        { name: 'docker-ce', installedVersion: null, candidateVersion: null },
        { name: 'docker-ce-cli', installedVersion: null, candidateVersion: null },
        { name: 'containerd.io', installedVersion: null, candidateVersion: null },
        { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: null },
        { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: null },
      ],
    }));
    expect(bare.stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([
      'docker_repository', 'docker_packages', 'docker_service',
    ]));
    const install = allSteps(bare).find((entry) => entry.id === 'install-docker-packages');
    expect(install?.command).toContain('apt-get install -y --no-install-recommends');
    expect(install?.command).toContain('docker-ce');
    expect(bare.notices.join(' ')).toContain('package versions are resolved');
    const service = allSteps(bare).find((entry) => entry.id === 'enable-start-docker');
    expect(service?.command).toContain('systemctl enable --now docker');
  });

  it('only enables the service when Docker is active but not enabled', () => {
    const plan = planFor(makeFacts({ docker: { serviceActive: true, serviceEnabled: false } }));
    const step = allSteps(plan).find((entry) => entry.id === 'enable-docker');
    expect(step?.command).toBe('sudo -n systemctl enable docker');
  });

  it('keeps the generated compose payload canonical at a custom path', () => {
    const facts = makeFacts({
      composeDir: makeComposeDir({ input: '/srv/sencho-stacks', normalized: '/srv/sencho-stacks', realPath: '/srv/sencho-stacks' }),
      agentDir: makeAgentDir({ input: '/srv/sencho-agent', normalized: '/srv/sencho-agent', realPath: '/srv/sencho-agent' }),
    });
    const plan = planFor(facts);
    const compose = allSteps(plan).find((entry) => entry.file?.path === '/srv/sencho-agent/compose.yaml');
    const parsed = parseYaml(compose!.file!.content) as {
      name: string;
      services: { agent: { container_name: string; image: string; restart: string; volumes: Array<string | { source: string; target: string }>; environment: Record<string, string> } };
      volumes: Record<string, unknown>;
    };
    expect(parsed.name).toBe('sencho-agent');
    expect(parsed.services.agent.container_name).toBe('sencho-agent');
    expect(parsed.services.agent.image).toBe('saelix/sencho:latest');
    expect(parsed.services.agent.restart).toBe('unless-stopped');
    expect(parsed.services.agent.environment.COMPOSE_DIR).toBe('/srv/sencho-stacks');
    expect(parsed.services.agent.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(parsed.services.agent.volumes).toContain('sencho-agent-data:/app/data');
    expect(parsed.services.agent.volumes).toContainEqual({ type: 'bind', source: '/srv/sencho-stacks', target: '/srv/sencho-stacks' });
    expect(parsed.volumes['sencho-agent-data']).toBeNull();
  });

  it('pins the project and clears ambient Compose and Docker variables in the start command', () => {
    const plan = planFor(makeFacts());
    const start = allSteps(plan).find((entry) => entry.id === 'start-agent');
    expect(start?.command).toContain('--project-name sencho-agent');
    expect(start?.command).toContain("--project-directory '/opt/sencho-agent'");
    expect(start?.command).toContain("-f '/opt/sencho-agent/compose.yaml'");
    expect(start?.command).toContain('-u COMPOSE_FILE');
    expect(start?.command).toContain('-u COMPOSE_PROJECT_NAME');
    expect(start?.command).toContain('-u DOCKER_HOST');
    expect(start?.command).toContain('-u DOCKER_CONTEXT');
    expect(start?.command).toContain('-u COMPOSE_PROFILES');
  });

  it('never writes inside the Compose directory and never destroys data', () => {
    const facts = makeFacts({ composeDir: { exists: false, isDirectory: false, parentWritableByUser: true } });
    const plan = planFor(facts, 'CA');
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/\brm -/);
    expect(serialized).not.toMatch(/\bchown -R/);
    expect(serialized).not.toMatch(/\bchmod -R/);
    expect(serialized).not.toMatch(/down -v/);
    const writes = allSteps(plan).filter((entry) => entry.effect === 'file-write' && entry.file);
    for (const step of writes) {
      expect(step.file?.path.startsWith('/opt/docker/sencho/')).toBe(false);
    }
  });

  it('records a previous bootstrap attempt as reconciliation, not a rewrite', () => {
    const facts = makeFacts({
      agentDir: {
        exists: true,
        isDirectory: true,
        writableByUser: true,
        entries: ['sencho-bootstrap.json', 'compose.yaml'],
        hasMarker: true,
        hasComposeFile: true,
        markerProject: 'sencho-agent',
        markerComposeDir: '/opt/docker/sencho',
        markerAgentDir: '/opt/sencho-agent',
      },
    });
    const plan = planFor(facts);
    expect(plan.notices.join(' ')).toContain('previous bootstrap attempt');
    expect(plan.skipped.find((entry) => entry.id === 'agent_dir')?.reason).toContain('previous bootstrap attempt');
  });

  it('produces a stable digest and changes it when a path, a mode, a stack or the marker changes', () => {
    const base = planFor(makeFacts({ composeDir: { stackCount: 0 } }));
    const same = planFor(makeFacts({ composeDir: { stackCount: 0 } }));
    expect(same.digest).toBe(base.digest);

    const cases: BootstrapFacts[] = [
      makeFacts({ composeDir: { input: '/opt/docker/other', normalized: '/opt/docker/other', realPath: '/opt/docker/other' } }),
      makeFacts({ composeDir: { realPath: '/srv/stacks' } }),
      makeFacts({ composeDir: { mode: '0775' } }),
      makeFacts({ composeDir: { stackCount: 4, stackNames: ['a'] } }),
      makeFacts({ agentDir: { exists: true, isDirectory: true, writableByUser: true, entries: [], realPath: '/opt/sencho-agent' } }),
    ];
    for (const facts of cases) {
      expect(planFor(facts).digest).not.toBe(base.digest);
    }
  });

  it('exposes the digest and evidence digest in the formatted text', () => {
    const plan = planFor(makeFacts());
    const text = formatPlanText(plan);
    expect(text).toContain(`Plan digest: sha256:${plan.digest}`);
    expect(text).toContain('No changes have been made on this server.');
    expect(text).toContain('Expected after execution:');
    expect(plan.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(planDigest(plan)).toBe(plan.digest);
  });

  it('canonicalizes keys so the digest does not depend on insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

const missingAllPackages: BootstrapFacts['packages'] = [
  { name: 'docker-ce', installedVersion: null, candidateVersion: null },
  { name: 'docker-ce-cli', installedVersion: null, candidateVersion: null },
  { name: 'containerd.io', installedVersion: null, candidateVersion: null },
  { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: null },
  { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: null },
];

function freshFacts(overrides: Parameters<typeof makeFacts>[0] = {}): BootstrapFacts {
  return makeFacts({
    docker: {
      cliInstalled: false,
      serverVersion: null,
      composeVersion: null,
      serviceActive: false,
      serviceEnabled: false,
      socketAccess: 'none',
    },
    repo: {
      dockerSourceConfigured: false,
      keyringPresent: false,
      sourceVerified: false,
      keyringVerified: false,
      candidateSourceVerified: null,
    },
    packages: missingAllPackages,
    ...overrides,
  });
}

describe('bootstrap plan privileges and working installations', () => {
  it('starts a fresh non-root host through sudo after the install', () => {
    const plan = planFor(freshFacts());
    const start = allSteps(plan).find((entry) => entry.id === 'start-agent');
    expect(start?.privilege).toBe('sudo');
    expect(start?.command).toMatch(/^sudo -n env /);
    expect(start?.command).toContain('DOCKER_CONTEXT=default');
    expect(start?.command).toContain('DOCKER_HOST=unix:///var/run/docker.sock');
  });

  it('writes Agent files with sudo when only root can write the directory, even with direct Docker access', () => {
    const facts = makeFacts({
      agentDir: {
        exists: true,
        isDirectory: true,
        writableByUser: false,
        writableBySudo: true,
        readableByUser: true,
        entries: [],
      },
    });
    const files = allSteps(planFor(facts)).filter((entry) => entry.effect === 'file-write');
    expect(files).toHaveLength(2);
    for (const step of files) expect(step.privilege).toBe('sudo');
  });

  it('marks and prefixes every repository command that needs sudo', () => {
    const plan = planFor(freshFacts());
    const repo = plan.stages.find((stage) => stage.id === 'docker_repository');
    expect(repo).toBeDefined();
    for (const step of repo!.steps) {
      expect(step.privilege, step.id).toBe('sudo');
      if (step.command) expect(step.command, step.id).toMatch(/^sudo -n /);
    }
  });

  it('preserves a working distribution Docker instead of planning replacement packages', () => {
    const facts = makeFacts({
      packages: missingAllPackages,
      repo: {
        dockerSourceConfigured: false,
        keyringPresent: false,
        sourceVerified: false,
        keyringVerified: false,
        candidateSourceVerified: null,
      },
    });
    const plan = planFor(facts);
    expect(plan.stages.map((stage) => stage.id)).not.toContain('docker_repository');
    expect(plan.stages.map((stage) => stage.id)).not.toContain('docker_packages');
    expect(plan.skipped.find((entry) => entry.id === 'docker_packages')?.reason).toMatch(/already work/i);
    expect(plan.notices.join(' ')).toMatch(/does not install or replace Docker packages/i);
  });

  it('preserves a working installation missing one official plugin record', () => {
    const packages = missingAllPackages.map((pkg, index) => (
      index === 0 ? { ...pkg, installedVersion: '5:27.3.1-1' } : pkg
    ));
    const plan = planFor(makeFacts({ packages }));
    expect(plan.stages.map((stage) => stage.id)).not.toContain('docker_repository');
    expect(plan.stages.map((stage) => stage.id)).not.toContain('docker_packages');
  });

  it('still plans repository and packages for a host without working Docker', () => {
    const plan = planFor(freshFacts());
    expect(plan.stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([
      'docker_repository', 'docker_packages',
    ]));
  });

  it('reinstalls the Compose plugin when the CLI reports no Compose despite an installed package record', () => {
    const plan = planFor(makeFacts({
      docker: { composeVersion: null },
      repo: {
        probeComplete: true,
        dockerSourceConfigured: true,
        keyringPresent: true,
        sourceVerified: true,
        keyringVerified: true,
        candidateSourceVerified: null,
        problem: null,
      },
    }));
    const packages = allSteps(plan).find((entry) => entry.id === 'install-docker-packages');
    expect(packages?.command).toContain('docker-compose-plugin');
    expect(plan.stages.map((stage) => stage.id)).toContain('docker_packages');
  });

  it('names the retained canonical Compose volume in the plan notice', () => {
    const plan = planFor(makeFacts({
      agent: { dataVolumeExists: true, dataVolumeNames: ['sencho-agent_sencho-agent-data'] },
    }));
    expect(plan.notices.join(' ')).toContain('sencho-agent_sencho-agent-data');
  });
});

describe('bootstrap plan export completeness', () => {
  it('exports ordered stages, every skip, file contents and both digests', () => {
    const plan = planFor(makeFacts({
      agentDir: { exists: false, isDirectory: false, parentWritableByUser: true },
      composeDir: { stackCount: 2 },
    }));
    const text = formatPlanText(plan);
    expect(text).toContain('Generated:');
    expect(text).toContain(plan.hubUrl);
    expect(text).toContain(`Evidence digest: sha256:${plan.evidenceDigest}`);
    expect(text).toContain(`Plan digest: sha256:${plan.digest}`);
    expect(text).toContain('Not changed:');
    for (const id of ['docker_repository', 'docker_packages', 'docker_service', 'compose_dir']) {
      expect(text, id).toContain(id);
    }
    expect(text).toContain('file: /opt/sencho-agent/compose.yaml (0600) [redacted]');
    expect(text).toContain('file: /opt/sencho-agent/sencho-bootstrap.json (0600)');
    expect(text).toContain('content:');
    expect(text).toContain('{{SENCHO_ENROLL_TOKEN}}');
    expect(text).toContain('"project": "sencho-agent"');
    expect(text).toMatch(/## 1\. .*\n[\s\S]*## 2\. [\s\S]*## 3\. /);
    expect(text).toContain('Evidence digest');
  });
});

describe('bootstrap plan prerequisites', () => {
  it('refuses to invent an operating system or user', () => {
    expect(() => planFor(makeFacts({ os: null }))).toThrow(/operating system/i);
    expect(() => planFor(makeFacts({ user: null }))).toThrow(/SSH user/i);
    expect(() => planFor(makeFacts({ composeDir: { probeError: 'stat failed' } }))).toThrow(/could not be inspected/i);
    expect(() => planFor(makeFacts({ agentDir: { probeError: 'stat failed' } }))).toThrow(/could not be inspected/i);
    expect(() => planFor(makeFacts({ composeDir: { inventoryError: 'exited 1' } }))).toThrow(/could not be inspected/i);
    expect(() => planFor(makeFacts({
      docker: { cliInstalled: false, serverVersion: null, composeVersion: null, socketAccess: 'none' },
      repo: {
        probeComplete: false,
        dockerSourceConfigured: false,
        keyringPresent: false,
        sourceVerified: null,
        keyringVerified: null,
        candidateSourceVerified: null,
        problem: 'probe failed',
      },
    }))).toThrow(/package source could not be inspected/i);
  });
});
