import crypto from 'crypto';
import { buildPilotEnrollmentCompose } from '../../helpers/pilotEnrollmentCompose';
import {
  BOOTSTRAP_MARKER_FILENAME,
  BOOTSTRAP_MARKER_SCHEMA_VERSION,
  PILOT_CONTAINER_NAME,
  PILOT_DATA_VOLUME,
  PILOT_IMAGE_REF,
  PILOT_PROJECT_NAME,
  shellQuote,
} from './pathPolicy';
import type {
  BootstrapFacts,
  BootstrapPlan,
  BootstrapPlanStep,
  BootstrapStageId,
  DockerPackage,
} from './types';

/**
 * Pure plan builder for the bootstrap workflow.
 *
 * The plan is the artifact S2 approves and executes, so every mutating step
 * carries its exact command, mode, owner and privilege. Steps that do not apply
 * are recorded as skipped with a reason rather than omitted, so "nothing to do"
 * is visible instead of an empty stage. No command here writes inside the
 * Compose directory, and none of them deletes, recursively chowns, recursively
 * chmods, or tears down a volume.
 */

export const BOOTSTRAP_PLAN_VERSION = 1 as const;

const MARKER_MODE = '0600';
const COMPOSE_FILE_MODE = '0600';
const CA_FILE_MODE = '0644';

export interface PlanBuildInput {
  facts: BootstrapFacts;
  targetName: string;
  hubUrl: string;
  caPem?: string | null;
  now: number;
}

/** Stable JSON: object keys sorted so the digest does not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function evidenceDigestOf(facts: BootstrapFacts): string {
  return sha256Hex(canonicalJson(facts));
}

function installDirCommand(path: string, mode: string, owner: string, group: string, sudo: boolean): string {
  const base = `install -d -m ${mode} -o ${shellQuote(owner)} -g ${shellQuote(group)} -- ${shellQuote(path)}`;
  return sudo ? `sudo -n ${base}` : base;
}

function startCommand(facts: BootstrapFacts, agentDir: string, sudo: boolean): string {
  const compose = `${agentDir}/compose.yaml`;
  const base = [
    'env -u DOCKER_HOST -u DOCKER_CONTEXT -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES',
    'docker compose',
    `--project-name ${PILOT_PROJECT_NAME}`,
    `--project-directory ${shellQuote(agentDir)}`,
    `-f ${shellQuote(compose)}`,
    'up -d',
  ].join(' ');
  return sudo ? `sudo -n ${base}` : base;
}

function packageInstallCommand(packages: DockerPackage[], resolved: boolean): string {
  const specs = packages.map((pkg) => (
    resolved && pkg.candidateVersion ? `${pkg.name}=${pkg.candidateVersion}` : pkg.name
  ));
  return `apt-get install -y --no-install-recommends ${specs.join(' ')}`;
}

function repoSteps(facts: BootstrapFacts, sudo: boolean): BootstrapPlanStep[] {
  const codename = facts.os?.codename || 'jammy';
  const arch = facts.os?.arch === 'x86_64' ? 'amd64' : (facts.os?.arch || 'amd64');
  const sourcesLine = `deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable`;
  return [
    {
      id: 'docker-keyring-dir',
      title: 'Create the Docker keyring directory',
      rationale: 'The Docker repository key must be readable by apt from a stable location.',
      effect: 'directory-create',
      privilege: sudo ? 'sudo' : 'user',
      command: installDirCommand('/etc/apt/keyrings', '0755', 'root', 'root', sudo),
      target: { path: '/etc/apt/keyrings', mode: '0755', owner: 'root', group: 'root', preserveExisting: true },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    },
    {
      id: 'docker-key',
      title: 'Fetch the Docker repository key',
      rationale: 'apt verifies the Docker package signatures with this key.',
      effect: 'file-write',
      privilege: sudo ? 'sudo' : 'user',
      command: `curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc`,
      target: { path: '/etc/apt/keyrings/docker.asc', mode: CA_FILE_MODE, owner: 'root', group: 'root', preserveExisting: false },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 30_000,
    },
    {
      id: 'docker-key-mode',
      title: 'Make the Docker key world-readable',
      rationale: 'apt reads the key as a non-root user.',
      effect: 'file-write',
      privilege: sudo ? 'sudo' : 'user',
      command: 'chmod 0644 /etc/apt/keyrings/docker.asc',
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    },
    {
      id: 'docker-sources',
      title: 'Write the Docker apt source',
      rationale: 'The official Docker repository replaces distribution packages that are often out of date.',
      effect: 'file-write',
      privilege: sudo ? 'sudo' : 'user',
      command: null,
      target: { path: '/etc/apt/sources.list.d/docker.list', mode: '0644', owner: 'root', group: 'root', preserveExisting: false },
      file: {
        path: '/etc/apt/sources.list.d/docker.list',
        mode: '0644',
        content: `${sourcesLine}\n`,
        redacted: false,
      },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    },
    {
      id: 'apt-update',
      title: 'Refresh apt metadata',
      rationale: 'The new repository must be indexed before its packages can be resolved.',
      effect: 'package-metadata',
      privilege: sudo ? 'sudo' : 'user',
      command: 'apt-get update',
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 120_000,
    },
  ];
}

function agentProjectSteps(
  input: PlanBuildInput,
  facts: BootstrapFacts,
  owner: string,
  group: string,
  previousAttempt: boolean,
): BootstrapPlanStep[] {
  const agentDir = facts.paths.agentDir.input;
  const managedByRoot = facts.docker.socketAccess === 'sudo' || facts.user?.isRoot === true;
  const fileOwner = managedByRoot ? 'root' : owner;
  const fileGroup = managedByRoot ? 'root' : group;
  // Writing a root-owned file needs sudo unless the session is already root.
  const filePrivilege: BootstrapPlanStep['privilege'] = managedByRoot && facts.user?.isRoot !== true ? 'sudo' : 'user';
  const marker = {
    schemaVersion: BOOTSTRAP_MARKER_SCHEMA_VERSION,
    project: PILOT_PROJECT_NAME,
    composeDir: facts.paths.composeDir.input,
    agentDir,
    createdAt: input.now,
  };
  const composeYaml = buildPilotEnrollmentCompose({
    primaryUrl: input.hubUrl,
    token: '{{SENCHO_ENROLL_TOKEN}}',
    composeDir: facts.paths.composeDir.input,
    caPem: input.caPem ?? undefined,
  });
  const steps: BootstrapPlanStep[] = [
    {
      id: 'bootstrap-marker',
      title: 'Write the bootstrap marker',
      rationale: previousAttempt
        ? 'The existing marker identifies this directory as our own previous attempt, so a retry reconciles instead of blocking.'
        : 'The marker lets a later retry or recovery tell this installation apart from an unrelated one.',
      effect: 'file-write',
      privilege: filePrivilege,
      command: null,
      target: { path: `${agentDir}/${BOOTSTRAP_MARKER_FILENAME}`, mode: MARKER_MODE, owner: fileOwner, group: fileGroup, preserveExisting: previousAttempt },
      file: {
        path: `${agentDir}/${BOOTSTRAP_MARKER_FILENAME}`,
        mode: MARKER_MODE,
        content: `${JSON.stringify(marker, null, 2)}\n`,
        redacted: false,
      },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    },
    {
      id: 'agent-compose-file',
      title: 'Write the Pilot compose file',
      rationale: 'The agent runs from this file. It is written atomically and never carries the enrollment token in this preview.',
      effect: 'file-write',
      privilege: filePrivilege,
      command: null,
      target: { path: `${agentDir}/compose.yaml`, mode: COMPOSE_FILE_MODE, owner: fileOwner, group: fileGroup, preserveExisting: previousAttempt },
      file: {
        path: `${agentDir}/compose.yaml`,
        mode: COMPOSE_FILE_MODE,
        content: composeYaml,
        redacted: true,
      },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    },
  ];
  if (input.caPem) {
    steps.push({
      id: 'agent-hub-ca',
      title: 'Write the hub CA certificate',
      rationale: 'The Pilot trusts the hub certificate chain from this file.',
      effect: 'file-write',
      privilege: filePrivilege,
      command: null,
      target: { path: `${agentDir}/sencho-hub-ca.pem`, mode: CA_FILE_MODE, owner: fileOwner, group: fileGroup, preserveExisting: true },
      file: {
        path: `${agentDir}/sencho-hub-ca.pem`,
        mode: CA_FILE_MODE,
        content: input.caPem,
        redacted: false,
      },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    });
  }
  return steps;
}

export function buildBootstrapPlan(input: PlanBuildInput): BootstrapPlan {
  const { facts } = input;
  const owner = facts.user?.name ?? facts.target.username;
  const group = facts.user?.group ?? owner;
  const root = facts.user?.isRoot === true;
  const sudoAvailable = root || facts.user?.sudoNonInteractive === true;
  const sudoDocker = facts.docker.socketAccess === 'sudo';
  const stages: BootstrapPlan['stages'] = [];
  const skipped: BootstrapPlan['skipped'] = [];
  const notices: string[] = ['No changes have been made on this server.'];

  const repoConfigured = facts.repo.dockerSourceConfigured && facts.repo.keyringPresent;
  const missingPackages = facts.packages.filter((pkg) => pkg.installedVersion === null);
  const needsRepo = !repoConfigured || missingPackages.length > 0;

  if (needsRepo) {
    stages.push({
      id: 'docker_repository',
      title: 'Docker package repository',
      steps: repoSteps(facts, !root),
    });
  } else {
    skipped.push({ id: 'docker_repository', reason: 'The official Docker repository and keyring are already configured.' });
  }

  if (missingPackages.length > 0) {
    const versionsKnown = missingPackages.every((pkg) => pkg.candidateVersion !== null);
    if (!versionsKnown) {
      notices.push('The Docker repository is not configured yet, so package versions are resolved from the official repository when the plan runs. Execution re-checks the resolved versions before installation.');
    }
    stages.push({
      id: 'docker_packages',
      title: 'Docker packages',
      steps: [{
        id: 'install-docker-packages',
        title: 'Install the missing Docker packages',
        rationale: 'The Pilot runs Docker Compose on this host.',
        effect: 'package-install',
        privilege: root ? 'user' : 'sudo',
        command: `${sudoAvailable && !root ? 'sudo -n ' : ''}${packageInstallCommand(missingPackages, versionsKnown)}`,
        disruptive: true,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 600_000,
      }],
    });
  } else {
    skipped.push({ id: 'docker_packages', reason: 'Docker CE, the CLI, containerd and the Compose plugin are already installed.' });
  }

  if (facts.docker.serviceActive === true && facts.docker.serviceEnabled === true) {
    skipped.push({ id: 'docker_service', reason: 'The Docker service is active and enabled at boot.' });
  } else if (facts.docker.serviceActive === true) {
    stages.push({
      id: 'docker_service',
      title: 'Docker service',
      steps: [{
        id: 'enable-docker',
        title: 'Enable Docker at boot',
        rationale: 'The agent must come back after a host reboot.',
        effect: 'service-change',
        privilege: root ? 'user' : 'sudo',
        command: `${root ? '' : 'sudo -n '}systemctl enable docker`,
        disruptive: true,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 60_000,
      }],
    });
  } else {
    stages.push({
      id: 'docker_service',
      title: 'Docker service',
      steps: [{
        id: 'enable-start-docker',
        title: 'Enable and start Docker',
        rationale: 'The agent needs a running Docker daemon, and it must survive a reboot.',
        effect: 'service-change',
        privilege: root ? 'user' : 'sudo',
        command: `${root ? '' : 'sudo -n '}systemctl enable --now docker`,
        disruptive: true,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 60_000,
      }],
    });
  }

  const composeDir = facts.paths.composeDir;
  if (composeDir.exists) {
    skipped.push({
      id: 'compose_dir',
      reason: `Existing directory preserved; ${composeDir.stackCount ?? 0} stack${composeDir.stackCount === 1 ? '' : 's'} found; ownership and mode unchanged.`,
    });
  } else {
    stages.push({
      id: 'compose_dir',
      title: 'Compose stacks directory',
      steps: [{
        id: 'create-compose-dir',
        title: 'Create the Compose stacks directory',
        rationale: 'Sencho manages the Compose project folders in this directory.',
        effect: 'directory-create',
        privilege: composeDir.parentWritableByUser ? 'user' : 'sudo',
        command: installDirCommand(composeDir.input, '0755', owner, group, !composeDir.parentWritableByUser && !root),
        target: { path: composeDir.input, mode: '0755', owner, group, preserveExisting: false },
        disruptive: false,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 10_000,
      }],
    });
  }

  const agentDir = facts.paths.agentDir;
  const previousAttempt = agentDir.exists && agentDir.hasMarker && agentDir.entries.length > 0;
  if (agentDir.exists) {
    skipped.push({
      id: 'agent_dir',
      reason: previousAttempt
        ? 'Existing agent directory reused from a previous bootstrap attempt; files are reconciled against this plan.'
        : 'The agent directory already exists and is empty; it is reused with its current ownership.',
    });
  } else {
    stages.push({
      id: 'agent_dir',
      title: 'Pilot Agent installation directory',
      steps: [{
        id: 'create-agent-dir',
        title: 'Create the Agent installation directory',
        rationale: 'The agent keeps its compose file and hub CA in a dedicated directory.',
        effect: 'directory-create',
        privilege: agentDir.parentWritableByUser ? 'user' : 'sudo',
        command: installDirCommand(agentDir.input, '0700', owner, group, !agentDir.parentWritableByUser && !root),
        target: { path: agentDir.input, mode: '0700', owner, group, preserveExisting: false },
        disruptive: false,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 10_000,
      }],
    });
  }

  stages.push({
    id: 'agent_project',
    title: 'Agent files',
    steps: agentProjectSteps(input, facts, owner, group, previousAttempt),
  });

  stages.push({
    id: 'agent_start',
    title: 'Start the Pilot agent',
    steps: [{
      id: 'start-agent',
      title: `Start the ${PILOT_PROJECT_NAME} project`,
      rationale: 'The project name and directory are pinned so ambient Compose variables cannot change which project runs.',
      effect: 'container-start',
      privilege: sudoDocker ? 'sudo' : 'user',
      command: startCommand(facts, agentDir.input, sudoDocker),
      disruptive: true,
      reversible: 'yes',
      pointOfNoReturn: true,
      timeoutMs: 300_000,
    }],
  });

  if ((composeDir.stackCount ?? 0) > 0) {
    notices.push(`${composeDir.stackCount} existing stack folder${composeDir.stackCount === 1 ? '' : 's'} in ${composeDir.input} will be left untouched.`);
  }
  if (facts.agent.dataVolumeExists === true) {
    notices.push(`The ${PILOT_DATA_VOLUME} volume already exists. Execution verifies the stored Pilot identity before reusing it.`);
  }
  if (previousAttempt) {
    notices.push('A previous bootstrap attempt was found in the agent directory. Execution reconciles it against this plan and never overwrites a file whose content differs.');
  }

  const versions: Record<string, string | null> = {
    docker: facts.docker.serverVersion,
    compose: facts.docker.composeVersion,
  };
  for (const pkg of facts.packages) versions[pkg.name] = pkg.installedVersion;

  const plan: BootstrapPlan = {
    version: BOOTSTRAP_PLAN_VERSION,
    generatedAt: input.now,
    target: facts.target,
    targetName: input.targetName,
    hostKeyFingerprint: facts.hostKey.fingerprint,
    hubUrl: input.hubUrl,
    paths: {
      composeDir: {
        input: composeDir.input,
        realPath: composeDir.realPath,
        exists: composeDir.exists,
        created: !composeDir.exists,
        stackCount: composeDir.stackCount,
      },
      agentDir: {
        input: agentDir.input,
        realPath: agentDir.realPath,
        exists: agentDir.exists,
        created: !agentDir.exists,
      },
    },
    projectName: PILOT_PROJECT_NAME,
    containerName: PILOT_CONTAINER_NAME,
    dataVolume: PILOT_DATA_VOLUME,
    image: { ref: PILOT_IMAGE_REF, digest: null, resolvedAt: 'execution' },
    stages,
    skipped,
    sources: [
      { name: 'Docker', url: 'https://download.docker.com/linux/ubuntu', keyFingerprint: null },
    ],
    versions,
    redactions: [
      { placeholder: '{{SENCHO_ENROLL_TOKEN}}', purpose: 'Minted when execution starts, valid for 15 minutes and never written to the plan.' },
      { placeholder: '{{SSH_PRIVATE_KEY}}', purpose: 'Used only for this preflight and never stored, logged or returned.' },
    ],
    verification: [
      { id: 'project-exists', title: `The ${PILOT_PROJECT_NAME} project exists`, expected: 'docker compose ls lists the project', slice: 'S2' },
      { id: 'container-running', title: `The ${PILOT_CONTAINER_NAME} container is running`, expected: 'docker inspect reports running', slice: 'S2' },
      { id: 'labels-point-at-dir', title: 'Compose labels point at the chosen agent directory', expected: `${agentDir.input} in com.docker.compose.project.working_dir`, slice: 'S2' },
      { id: 'compose-mount', title: 'The Compose directory is mounted at the same path', expected: `bind source and target both equal ${composeDir.input}`, slice: 'S3' },
      { id: 'compose-writable-in-agent', title: 'The agent can read and write the Compose directory', expected: 'a test write inside the agent succeeds', slice: 'S3' },
      { id: 'agent-compose-version', title: 'docker compose works inside the agent', expected: 'docker compose version succeeds', slice: 'S3' },
      { id: 'agent-docker-inventory', title: 'A read-only Docker inventory works inside the agent', expected: 'docker ps succeeds', slice: 'S3' },
      { id: 'tunnel-connected', title: 'The tunnel is connected with the expected identity', expected: 'the node reports connected', slice: 'S3' },
      { id: 'capability-match', title: 'The node capability and version match the hub', expected: 'capabilities and version agree', slice: 'S3' },
    ],
    notices,
    evidenceDigest: evidenceDigestOf(facts),
    digest: '',
  };
  plan.digest = planDigest(plan);
  return plan;
}

/** Digest over the plan without its generation time and without the digest itself. */
export function planDigest(plan: BootstrapPlan): string {
  const { generatedAt: _generatedAt, digest: _digest, ...rest } = plan;
  return sha256Hex(canonicalJson(rest));
}

export const BOOTSTRAP_STAGE_ORDER: BootstrapStageId[] = [
  'docker_repository',
  'docker_packages',
  'docker_service',
  'compose_dir',
  'agent_dir',
  'agent_project',
  'agent_start',
];

/** Human-readable plan text for Copy plan / Download plan. */
export function formatPlanText(plan: BootstrapPlan): string {
  const lines: string[] = [];
  lines.push(`Sencho bootstrap plan v${plan.version}`);
  lines.push(`Target: ${plan.targetName} (${plan.target.username}@${plan.target.host}:${plan.target.port}, ${plan.target.address})`);
  lines.push(`Host key: ${plan.hostKeyFingerprint}`);
  lines.push(`Compose stacks directory: ${plan.paths.composeDir.input}`);
  lines.push(`Pilot Agent installation directory: ${plan.paths.agentDir.input}`);
  lines.push(`Project: ${plan.projectName}  Container: ${plan.containerName}  Volume: ${plan.dataVolume}`);
  lines.push('');
  for (const stage of plan.stages) {
    lines.push(`## ${stage.title}`);
    for (const step of stage.steps) {
      lines.push(`- ${step.title} (${step.privilege}, ${step.effect})`);
      if (step.target) {
        lines.push(`  path: ${step.target.path} mode: ${step.target.mode ?? 'unchanged'} owner: ${step.target.owner ?? 'unchanged'}`);
      }
      if (step.command) lines.push(`  command: ${step.command}`);
      if (step.file) lines.push(`  file: ${step.file.path} (${step.file.mode})`);
    }
    lines.push('');
  }
  for (const skip of plan.skipped) lines.push(`Skipped ${skip.id}: ${skip.reason}`);
  if (plan.skipped.length > 0) lines.push('');
  for (const notice of plan.notices) lines.push(`Note: ${notice}`);
  lines.push('');
  lines.push('Expected after execution:');
  for (const item of plan.verification) lines.push(`- [${item.slice}] ${item.title}: ${item.expected}`);
  lines.push('');
  lines.push(`Plan digest: sha256:${plan.digest}`);
  return lines.join('\n');
}
