import crypto from 'crypto';
import { buildPilotEnrollmentCompose } from '../../helpers/pilotEnrollmentCompose';
import {
  dockerAndComposeWork,
  dockerEngineWorks,
  missingDockerPackages,
  plannedDockerPackages,
  repoVerified,
  unsupportedComposeAddition,
} from './evidence';
import { DOCKER_LOCAL_ASSIGNMENTS, DOCKER_LOCAL_UNSET_ARGS, debianArchitecture } from './probes';
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
/**
 * A freshly booted Ubuntu host often runs its own apt jobs for a few minutes;
 * apt waits for their lock instead of failing at once.
 */
const APT_LOCK_WAIT = '-o DPkg::Lock::Timeout=300';
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

function sudoCommand(command: string, sudo: boolean): string {
  return sudo ? `sudo -n ${command}` : command;
}

function installDirCommand(path: string, mode: string, owner: string, group: string, sudo: boolean): string {
  return sudoCommand(`install -d -m ${mode} -o ${shellQuote(owner)} -g ${shellQuote(group)} -- ${shellQuote(path)}`, sudo);
}

function startCommand(agentDir: string, sudo: boolean): string {
  const compose = `${agentDir}/compose.yaml`;
  // Pin both the Docker endpoint and the Compose project: a configured remote
  // context or ambient Compose variable must not change which daemon or project
  // this command starts.
  const base = [
    `env ${DOCKER_LOCAL_UNSET_ARGS} -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES ${DOCKER_LOCAL_ASSIGNMENTS}`,
    'docker compose',
    `--project-name ${PILOT_PROJECT_NAME}`,
    `--project-directory ${shellQuote(agentDir)}`,
    `-f ${shellQuote(compose)}`,
    'up -d',
  ].join(' ');
  return sudoCommand(base, sudo);
}

function packageInstallCommand(packages: DockerPackage[], resolved: boolean): string {
  const specs = packages.map((pkg) => (
    resolved && pkg.candidateVersion ? `${pkg.name}=${pkg.candidateVersion}` : pkg.name
  ));
  return `apt-get ${APT_LOCK_WAIT} install -y --no-install-recommends ${specs.join(' ')}`;
}

function aptUpdateStep(sudo: boolean): BootstrapPlanStep {
  return {
    id: 'apt-update',
    title: 'Refresh apt metadata',
    rationale: 'The Docker repository must be indexed before its packages can be resolved.',
    effect: 'package-metadata',
    privilege: sudo ? 'sudo' : 'user',
    command: sudoCommand(`apt-get ${APT_LOCK_WAIT} update`, sudo),
    disruptive: false,
    reversible: 'yes',
    pointOfNoReturn: false,
    timeoutMs: 120_000,
  };
}

function repoSteps(facts: BootstrapFacts, sudo: boolean): BootstrapPlanStep[] {
  const codename = facts.os?.codename;
  if (!codename) throw new Error('The plan requires a known Ubuntu codename.');
  if (!facts.os?.arch) throw new Error('The plan requires a known architecture.');
  const arch = debianArchitecture(facts.os.arch);
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
      command: sudoCommand('curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc', sudo),
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
      command: sudoCommand('chmod 0644 /etc/apt/keyrings/docker.asc', sudo),
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
    aptUpdateStep(sudo),
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
  // File privilege follows the directory that receives the write, not Docker
  // socket access: the user who can write the directory owns the result.
  const dirWritableByUser = facts.paths.agentDir.exists
    ? facts.paths.agentDir.writableByUser
    : facts.paths.agentDir.parentWritableByUser === true;
  const filePrivilege: BootstrapPlanStep['privilege'] = dirWritableByUser || facts.user?.isRoot === true ? 'user' : 'sudo';
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
      target: { path: `${agentDir}/${BOOTSTRAP_MARKER_FILENAME}`, mode: MARKER_MODE, owner, group, preserveExisting: previousAttempt },
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
      target: { path: `${agentDir}/compose.yaml`, mode: COMPOSE_FILE_MODE, owner, group, preserveExisting: previousAttempt },
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
      target: { path: `${agentDir}/sencho-hub-ca.pem`, mode: CA_FILE_MODE, owner, group, preserveExisting: true },
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
  // The evidence gate suppresses the plan when a required fact is unknown.
  // These guards make a direct call fail closed too, rather than inventing a
  // default distribution, user or filesystem.
  if (!facts.os) throw new Error('The plan requires a known operating system.');
  if (facts.docker.cliProbeUnknown) throw new Error('The plan requires a complete Docker CLI probe.');
  if (!facts.user) throw new Error('The plan requires a known SSH user.');
  if (facts.paths.composeDir.probeError || facts.paths.agentDir.probeError
    || facts.paths.composeDir.inventoryError || facts.paths.agentDir.inventoryError) {
    throw new Error('The plan cannot be built while a directory could not be inspected.');
  }
  if ((!facts.repo.probeComplete || !facts.packagesComplete) && !dockerAndComposeWork(facts)) {
    throw new Error('The plan cannot be built while the Docker package source could not be inspected.');
  }
  if ((facts.docker.cliInstalled && facts.docker.socketAccess === 'unknown') || facts.docker.composeProbeUnknown) {
    throw new Error('The plan requires complete Docker daemon and Compose probes.');
  }
  if (facts.docker.cliInstalled && (!facts.containers.complete || facts.agent.dataVolumeExists === null)) {
    throw new Error('The plan requires a complete container and volume inventory.');
  }
  if (facts.agent.defaultDirHasComposeFile === null) {
    throw new Error('The plan requires the default Pilot directory to be checked.');
  }
  if (unsupportedComposeAddition(facts)) {
    throw new Error('The plan cannot add Compose to a Docker engine that was not installed from Docker packages.');
  }
  const dockerWorking = dockerAndComposeWork(facts);
  const repoConfigured = repoVerified(facts);
  const needsRepo = !dockerWorking && !repoConfigured;
  if (needsRepo && facts.repo.dockerSourceConfigured) {
    throw new Error('The plan cannot write the Docker apt source beside an existing Docker source that is not verified.');
  }
  if (needsRepo && facts.repo.sourceLocations !== 'default') {
    throw new Error('The plan cannot add the Docker apt source while the locations apt reads its sources from are not the defaults.');
  }
  const owner = facts.user.name;
  const group = facts.user.group;
  const root = facts.user.isRoot;
  const sudoAvailable = root || facts.user.sudoNonInteractive === true;
  const sudoDocker = facts.docker.socketAccess === 'sudo';
  const stages: BootstrapPlan['stages'] = [];
  const skipped: BootstrapPlan['skipped'] = [];
  const notices: string[] = ['No changes have been made on this server.'];

  const packagesToInstall = plannedDockerPackages(facts);
  const needsMetadataRefresh = !dockerWorking && !needsRepo && packagesToInstall.length > 0;

  if (needsRepo) {
    stages.push({
      id: 'docker_repository',
      title: 'Docker package repository',
      steps: repoSteps(facts, !root),
    });
  } else if (needsMetadataRefresh) {
    stages.push({
      id: 'docker_repository',
      title: 'Docker package metadata',
      steps: [aptUpdateStep(!root)],
    });
  } else if (dockerWorking && !repoConfigured) {
    skipped.push({
      id: 'docker_repository',
      reason: 'Docker and Compose already work; the existing installation is preserved and its package source is not replaced.',
    });
  } else {
    skipped.push({ id: 'docker_repository', reason: 'The official Docker repository and keyring are already configured.' });
  }

  if (dockerWorking && missingDockerPackages(facts).length > 0) {
    skipped.push({
      id: 'docker_packages',
      reason: 'Docker and Compose already work; the existing distribution installation is preserved instead of being replaced.',
    });
    notices.push('Docker and Compose already work on this host. The plan does not install or replace Docker packages.');
  } else if (packagesToInstall.length > 0) {
    const composeOnly = dockerEngineWorks(facts);
    if (composeOnly) {
      notices.push('Docker already runs on this host. Only the Compose plugin is installed; the engine, containerd and every container are left as they are.');
    }
    const versionsKnown = packagesToInstall.every((pkg) => pkg.candidateVersion !== null);
    if (!versionsKnown) {
      notices.push("Package versions are not available from the local apt index yet, so they are resolved from the official repository when the plan runs. Before installing, the run checks that every package's candidate comes from the official Docker repository, and installs nothing if one does not.");
    }
    stages.push({
      id: 'docker_packages',
      title: 'Docker packages',
      steps: [{
        id: 'install-docker-packages',
        title: composeOnly ? 'Install the Docker Compose plugin' : 'Install the missing Docker packages',
        rationale: 'The Pilot runs Docker Compose on this host.',
        effect: 'package-install',
        privilege: root ? 'user' : 'sudo',
        command: sudoCommand(packageInstallCommand(packagesToInstall, versionsKnown), sudoAvailable && !root),
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
        command: sudoCommand('systemctl enable docker', !root),
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
        command: sudoCommand('systemctl enable --now docker', !root),
        disruptive: true,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 60_000,
      }],
    });
  }

  const composeDir = facts.paths.composeDir;
  if (composeDir.exists) {
    const stackDetail = composeDir.stackCount === null
      ? 'stack count unknown'
      : `${composeDir.stackCount} stack${composeDir.stackCount === 1 ? '' : 's'} found`;
    skipped.push({
      id: 'compose_dir',
      reason: `Existing directory preserved; ${stackDetail}; ownership and mode unchanged.`,
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

  // A fresh install reaches the socket as root until the user is in the docker
  // group, so the start command follows the post-install access, not the
  // pre-install probe.
  const startSudo = !root && (sudoDocker || !facts.docker.cliInstalled || facts.docker.socketAccess === 'none');
  stages.push({
    id: 'agent_start',
    title: 'Start the Pilot agent',
    steps: [{
      id: 'start-agent',
      title: `Start the ${PILOT_PROJECT_NAME} project`,
      rationale: 'The project name, directory and local Docker endpoint are pinned so ambient variables and contexts cannot change which project or daemon runs.',
      effect: 'container-start',
      privilege: startSudo ? 'sudo' : 'user',
      command: startCommand(agentDir.input, startSudo),
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
    const volumeNames = facts.agent.dataVolumeNames.length > 0
      ? facts.agent.dataVolumeNames.join(', ')
      : PILOT_DATA_VOLUME;
    notices.push(`The ${volumeNames} volume already exists and is kept. Only a volume this bootstrap's own earlier attempt created gets this far; any other blocks the preflight.`);
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
      { placeholder: '{{SENCHO_ENROLL_TOKEN}}', purpose: 'Minted when the run reaches the compose file, after the Docker steps. Valid once, for 15 minutes, and never written to the plan.' },
      { placeholder: '{{SSH_PRIVATE_KEY}}', purpose: 'Used for the preflight and, when you approve, for the run. Held in memory only, never stored, logged or returned.' },
    ],
    verification: [
      { id: 'project-exists', title: `The ${PILOT_PROJECT_NAME} project exists`, expected: `docker inspect shows the ${PILOT_CONTAINER_NAME} container in the ${PILOT_PROJECT_NAME} project`, slice: 'S2' },
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

/**
 * Digest over the plan without its generation time and without the digest
 * itself. The marker file content carries its own creation time, so every
 * generated plan has its own digest; it identifies the reviewed artifact.
 */
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

/**
 * Human-readable plan text for Copy plan / Download plan. This is the retained
 * review artifact, so it carries every step in execution order, every skipped
 * stage, all file contents, both paths and both digests.
 */
export function formatPlanText(plan: BootstrapPlan): string {
  const lines: string[] = [];
  lines.push(`Sencho bootstrap plan v${plan.version}`);
  lines.push(`Generated: ${new Date(plan.generatedAt).toISOString()}`);
  lines.push(`Target: ${plan.targetName} (${plan.target.username}@${plan.target.host}:${plan.target.port}, ${plan.target.address})`);
  lines.push(`Host key: ${plan.hostKeyFingerprint}`);
  lines.push(`Hub URL: ${plan.hubUrl}`);
  lines.push(`Compose stacks directory: ${plan.paths.composeDir.input} (real: ${plan.paths.composeDir.realPath ?? 'unresolved'}, ${plan.paths.composeDir.created ? 'will be created' : `existing, ${plan.paths.composeDir.stackCount ?? 'unknown'} stacks`})`);
  lines.push(`Pilot Agent installation directory: ${plan.paths.agentDir.input} (real: ${plan.paths.agentDir.realPath ?? 'unresolved'}, ${plan.paths.agentDir.created ? 'will be created' : 'existing'})`);
  lines.push(`Project: ${plan.projectName}  Container: ${plan.containerName}  Volume: ${plan.dataVolume}`);
  lines.push(`Image: ${plan.image.ref} (digest ${plan.image.digest ?? 'resolved at execution'})`);
  lines.push(`Evidence digest: sha256:${plan.evidenceDigest}`);
  lines.push('');
  lines.push('Sources:');
  for (const source of plan.sources) {
    lines.push(`- ${source.name}: ${source.url}${source.keyFingerprint ? ` (key ${source.keyFingerprint})` : ''}`);
  }
  lines.push('');
  lines.push('Versions:');
  for (const [name, version] of Object.entries(plan.versions)) {
    lines.push(`- ${name}: ${version ?? 'not installed'}`);
  }
  lines.push('');
  for (const [index, stage] of plan.stages.entries()) {
    lines.push(`## ${index + 1}. ${stage.title} [${stage.id}]`);
    for (const step of stage.steps) {
      lines.push(`- ${step.title} [${step.id}] (${step.privilege}, ${step.effect}; disruptive=${step.disruptive}; reversible=${step.reversible}; pointOfNoReturn=${step.pointOfNoReturn}; timeout=${step.timeoutMs}ms)`);
      lines.push(`  rationale: ${step.rationale}`);
      if (step.target) {
        lines.push(`  path: ${step.target.path} mode: ${step.target.mode ?? 'unchanged'} owner: ${step.target.owner ?? 'unchanged'} group: ${step.target.group ?? 'unchanged'} preserveExisting: ${step.target.preserveExisting}`);
      }
      if (step.command) lines.push(`  command: ${step.command}`);
      if (step.file) {
        lines.push(`  file: ${step.file.path} (${step.file.mode})${step.file.redacted ? ' [redacted]' : ''}`);
        lines.push('  content:');
        for (const contentLine of step.file.content.replace(/\n$/, '').split('\n')) {
          lines.push(`    ${contentLine}`);
        }
      }
    }
    lines.push('');
  }
  lines.push('Not changed:');
  if (plan.skipped.length === 0) lines.push('- Nothing');
  for (const skip of plan.skipped) lines.push(`- ${skip.id}: ${skip.reason}`);
  lines.push('');
  lines.push('Redactions:');
  for (const redaction of plan.redactions) lines.push(`- ${redaction.placeholder}: ${redaction.purpose}`);
  lines.push('');
  for (const notice of plan.notices) lines.push(`Note: ${notice}`);
  lines.push('');
  lines.push('Expected after execution:');
  for (const item of plan.verification) lines.push(`- [${item.slice === 'S2' ? 'run' : 'readiness'}] ${item.title}: ${item.expected}`);
  lines.push('');
  lines.push(`Plan digest: sha256:${plan.digest}`);
  return lines.join('\n');
}
