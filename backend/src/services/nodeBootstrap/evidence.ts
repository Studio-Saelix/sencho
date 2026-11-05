import {
  DEFAULT_AGENT_DIR,
  PILOT_PROJECT_NAME,
  arePathsDisjoint,
  validatePathSyntax,
} from './pathPolicy';
import { validateHubUrl } from './probes';
import type {
  AgentDirObservation,
  BootstrapCheck,
  BootstrapFacts,
  ComposeDirObservation,
  PathObservation,
} from './types';

/**
 * Pure mapping from observed facts to evidence rows.
 *
 * The four verdicts mirror EnvironmentCheckService so operators read the same
 * language. `unknown` is a distinct state, never folded into pass, and any
 * blocker suppresses the plan.
 */

export const COMPOSE_FREE_BLOCK_BYTES = 2 * 1024 ** 3;
export const COMPOSE_FREE_WARN_BYTES = 5 * 1024 ** 3;
export const AGENT_FREE_BLOCK_BYTES = 512 * 1024 ** 2;
export const AGENT_FREE_WARN_BYTES = 1024 ** 3;
export const DOCKER_ROOT_FREE_BLOCK_BYTES = 2 * 1024 ** 3;
export const DOCKER_ROOT_FREE_WARN_BYTES = 5 * 1024 ** 3;

export const DENIED_FILESYSTEMS: readonly string[] = [
  'tmpfs',
  'ramfs',
  'overlay',
  'aufs',
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'sshfs',
  'fuse.*',
  '9p',
];

const PATH_CHECK_IDS = new Set(['compose_dir', 'agent_dir', 'path_separation']);

export interface EvidenceResult {
  checks: BootstrapCheck[];
  blockers: number;
  warnings: number;
  /** True when an unknown path fact makes a planned write unprovable. */
  planSuppressed: boolean;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return 'unreadable';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function isDeniedFilesystem(type: string | null | undefined): boolean {
  if (!type) return false;
  return DENIED_FILESYSTEMS.some((denied) => {
    if (denied.endsWith('.*')) return type.startsWith(denied.slice(0, -2));
    return type === denied;
  });
}

function modeHasOtherWrite(mode: string | null): boolean {
  if (!mode) return false;
  const parsed = Number.parseInt(mode, 8);
  return Number.isFinite(parsed) && (parsed & 0o002) !== 0;
}

function describePath(path: PathObservation): string {
  const parts = [
    path.exists ? 'exists' : 'missing',
    path.owner ? `owner=${path.owner}` : null,
    path.mode ? `mode=${path.mode}` : null,
    path.realPath && path.realPath !== path.input ? `real=${path.realPath}` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

function resolvedPathDenied(path: PathObservation, kind: 'compose' | 'agent'): string | null {
  if (!path.realPath || path.realPath === path.input) return null;
  const result = validatePathSyntax(path.realPath, kind);
  return result.ok ? null : (result.message ?? 'The resolved path is not allowed.');
}

function blockOnResolvedPath(
  path: PathObservation,
  kind: 'compose' | 'agent',
): BootstrapCheck | null {
  const denial = resolvedPathDenied(path, kind);
  if (!denial) return null;
  const id = kind === 'compose' ? 'compose_dir' : 'agent_dir';
  return {
    id,
    category: 'paths',
    label: kind === 'compose' ? 'Compose stacks directory' : 'Pilot Agent installation directory',
    status: 'blocked',
    summary: `${path.input} resolves to ${path.realPath}, which is not an allowed directory.`,
    observed: denial,
    remediation: 'Choose a directory that is not under a system root, or point the path at the real directory instead of a symlink.',
  };
}

function composeDirCheck(
  path: ComposeDirObservation,
  facts: BootstrapFacts,
): BootstrapCheck {
  const label = 'Compose stacks directory';
  const base = { id: 'compose_dir' as const, category: 'paths' as const, label };
  if (path.probeError) {
    return {
      ...base,
      status: 'unknown',
      summary: `The Compose directory could not be inspected: ${path.probeError}.`,
      observed: path.probeError,
      remediation: 'Confirm the directory manually over SSH, or choose a path the SSH user can read.',
    };
  }
  const denied = blockOnResolvedPath(path, 'compose');
  if (denied) return denied;
  if (path.exists && !path.isDirectory) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} exists but is not a directory.`,
      observed: describePath(path),
      remediation: `Choose a directory path, or move the file at ${path.input} and run the preflight again.`,
    };
  }
  if (path.isFinalSymlink) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} is a symbolic link.`,
      observed: describePath(path),
      remediation: `Use the directory the link points to (${path.realPath ?? 'resolve it on the host'}) as the Compose directory.`,
    };
  }
  const keepAndDescribe = path.exists
    ? `${path.stackCount ?? 0} existing stack${path.stackCount === 1 ? '' : 's'} will be preserved.`
    : '';

  if (!path.exists) {
    const sudo = facts.user?.sudoNonInteractive === true || facts.user?.isRoot === true;
    if (!path.parentWritableByUser && !sudo) {
      return {
        ...base,
        status: 'blocked',
        summary: `${path.input} does not exist and the SSH user cannot create it.`,
        observed: describePath(path),
        remediation: 'Choose a path the SSH user can write, or enable non-interactive sudo for this user.',
      };
    }
    if (path.hasSymlinkAncestor) {
      return {
        ...base,
        status: 'warn',
        summary: `${path.input} will be created inside a symlinked directory that resolves to ${path.realPath ?? 'another path'}.`,
        observed: describePath(path),
        remediation: `Confirm that ${path.realPath ?? 'the resolved path'} is the directory you mean, then run the preflight again.`,
      };
    }
    return {
      ...base,
      status: 'pass',
      summary: `${path.input} will be created when the plan runs.`,
      observed: describePath(path),
    };
  }

  if (!path.readableByUser) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} cannot be read by the SSH user, so existing stacks cannot be inventoried.`,
      observed: describePath(path),
      remediation: 'Grant the SSH user read and traverse access to this directory, or choose another path.',
    };
  }
  if (!path.writableByUser) {
    if (path.writableBySudo) {
      return {
        ...base,
        status: 'warn',
        summary: `${path.input} is writable only through sudo. ${keepAndDescribe}`,
        observed: describePath(path),
        remediation: 'The Pilot writes as root through the Docker socket, so this works; manual edits need sudo. Change the ownership if you want direct edits.',
      };
    }
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} is not writable by the SSH user or by root.`,
      observed: describePath(path),
      remediation: 'Fix the directory ownership or permissions on the host, or choose another directory. Existing stacks are never chowned by this workflow.',
    };
  }
  if (path.hasSymlinkAncestor) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} is reached through a symlinked directory and resolves to ${path.realPath ?? 'another path'}. ${keepAndDescribe}`,
      observed: describePath(path),
      remediation: 'The resolved path is recorded in the plan digest. Confirm it is still the directory you mean before approving execution.',
    };
  }
  if (path.rootComposeFile) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} contains a root-level Compose file, so it looks like a single project rather than a stacks root. ${keepAndDescribe}`,
      observed: describePath(path),
      remediation: 'If Sencho should manage the projects inside this directory, choose their parent directory instead.',
    };
  }
  if (modeHasOtherWrite(path.mode)) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} is world-writable (mode ${path.mode}). ${keepAndDescribe}`,
      observed: describePath(path),
      remediation: 'Tighten the directory mode on the host if other users do not need write access. This workflow does not change it.',
    };
  }
  if (path.inventoryTruncated) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} has more stack folders than the inventory cap. ${keepAndDescribe}`,
      observed: describePath(path),
      remediation: 'The count is a lower bound. The plan will not write inside this directory.',
    };
  }
  if (path.owner && facts.user && path.owner !== facts.user.name) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} is owned by ${path.owner} and is writable by the SSH user. ${keepAndDescribe}`,
      observed: describePath(path),
      remediation: 'Ownership is preserved. If the Pilot should own the stacks, change it on the host before approving execution.',
    };
  }
  return {
    ...base,
    status: 'pass',
    summary: `${path.input} is writable. ${keepAndDescribe}`.trim(),
    observed: describePath(path),
  };
}

function agentDirCheck(
  path: AgentDirObservation,
  facts: BootstrapFacts,
  composeDir: string,
): BootstrapCheck {
  const label = 'Pilot Agent installation directory';
  const base = { id: 'agent_dir' as const, category: 'paths' as const, label };
  if (path.probeError) {
    return {
      ...base,
      status: 'unknown',
      summary: `The Agent directory could not be inspected: ${path.probeError}.`,
      observed: path.probeError,
      remediation: 'Confirm the directory contents manually over SSH, or choose an empty dedicated directory.',
    };
  }
  const denied = blockOnResolvedPath(path, 'agent');
  if (denied) return denied;
  if (path.exists && !path.isDirectory) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} exists but is not a directory.`,
      observed: describePath(path),
      remediation: `Choose an empty dedicated directory, or move the file at ${path.input} and run the preflight again.`,
    };
  }
  if (path.isFinalSymlink) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} is a symbolic link.`,
      observed: describePath(path),
      remediation: `Use the directory the link points to (${path.realPath ?? 'resolve it on the host'}) as the Agent directory.`,
    };
  }

  if (!path.exists) {
    const sudo = facts.user?.sudoNonInteractive === true || facts.user?.isRoot === true;
    if (!path.parentWritableByUser && !sudo) {
      return {
        ...base,
        status: 'blocked',
        summary: `${path.input} does not exist and the SSH user cannot create it.`,
        observed: describePath(path),
        remediation: 'Choose a path the SSH user can write, or enable non-interactive sudo for this user.',
      };
    }
    if (path.hasSymlinkAncestor) {
      return {
        ...base,
        status: 'warn',
        summary: `${path.input} will be created inside a symlinked directory that resolves to ${path.realPath ?? 'another path'}.`,
        observed: describePath(path),
        remediation: `Confirm that ${path.realPath ?? 'the resolved path'} is persistent and survives a reboot, then run the preflight again.`,
      };
    }
    return {
      ...base,
      status: 'pass',
      summary: `${path.input} will be created when the plan runs.`,
      observed: describePath(path),
    };
  }

  if (!path.writableByUser && !path.writableBySudo) {
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} is not writable by the SSH user or by root.`,
      observed: describePath(path),
      remediation: 'Choose an empty directory the SSH user can write, or enable non-interactive sudo for this user.',
    };
  }

  const ourMarker = path.hasMarker
    && path.markerProject === PILOT_PROJECT_NAME
    && path.markerComposeDir === composeDir
    && path.markerAgentDir === path.input;

  if (path.entries.length > 0) {
    const knownAttempt = ourMarker && path.entries.every((entry) => (
      entry === 'sencho-bootstrap.json' || entry === 'compose.yaml' || entry === 'sencho-hub-ca.pem'
    ));
    if (knownAttempt) {
      return {
        ...base,
        status: 'warn',
        summary: `${path.input} holds a previous bootstrap attempt for this project and these paths.`,
        observed: path.entries.join(', '),
        remediation: 'The plan reuses this directory instead of treating it as unrelated. Files whose content does not match the expected artifact are never overwritten.',
      };
    }
    if (path.hasMarker && !ourMarker) {
      return {
        ...base,
        status: 'blocked',
        summary: `${path.input} holds a bootstrap marker for a different project or different directories.`,
        observed: `${path.markerProject ?? 'unknown project'} / ${path.markerComposeDir ?? 'unknown stacks directory'}`,
        remediation: 'Choose an empty dedicated directory. The existing files are not touched.',
      };
    }
    return {
      ...base,
      status: 'blocked',
      summary: `${path.input} is not empty and does not belong to a previous bootstrap attempt.`,
      observed: path.entries.slice(0, 10).join(', '),
      remediation: 'Choose an empty dedicated directory. This workflow does not delete or overwrite existing files.',
    };
  }

  if (modeHasOtherWrite(path.mode)) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} is empty but world-writable (mode ${path.mode}).`,
      observed: describePath(path),
      remediation: 'Tighten the directory mode on the host before execution if other users do not need write access.',
    };
  }
  if (path.hasSymlinkAncestor) {
    return {
      ...base,
      status: 'warn',
      summary: `${path.input} is empty and reached through a symlinked directory that resolves to ${path.realPath ?? 'another path'}.`,
      observed: describePath(path),
      remediation: 'The resolved path is recorded in the plan digest. Confirm it survives a reboot before approving execution.',
    };
  }
  return {
    ...base,
    status: 'pass',
    summary: `${path.input} exists and is empty.`,
    observed: describePath(path),
  };
}

function diskSpaceCheck(facts: BootstrapFacts): BootstrapCheck {
  const base = { id: 'disk_space' as const, category: 'storage' as const, label: 'Free disk space' };
  const compose = facts.paths.composeDir;
  const agent = facts.paths.agentDir;
  const shared = compose.filesystem && agent.filesystem
    && compose.filesystem.mountPoint === agent.filesystem.mountPoint;
  const problems: string[] = [];
  let status: BootstrapCheck['status'] = 'pass';

  const evaluate = (name: string, free: number | null, warnAt: number, blockAt: number): void => {
    if (free === null) {
      if (status === 'pass') status = 'unknown';
      problems.push(`${name}: unreadable`);
      return;
    }
    if (free < blockAt) {
      status = 'blocked';
      problems.push(`${name}: ${fmtBytes(free)} free, under ${fmtBytes(blockAt)}`);
    } else if (free < warnAt && status !== 'blocked') {
      status = 'warn';
      problems.push(`${name}: ${fmtBytes(free)} free, under ${fmtBytes(warnAt)}`);
    }
  };

  if (shared) {
    evaluate(
      'Compose and Agent directories',
      compose.freeBytes,
      COMPOSE_FREE_WARN_BYTES,
      COMPOSE_FREE_BLOCK_BYTES,
    );
  } else {
    evaluate('Compose directory', compose.freeBytes, COMPOSE_FREE_WARN_BYTES, COMPOSE_FREE_BLOCK_BYTES);
    evaluate('Agent directory', agent.freeBytes, AGENT_FREE_WARN_BYTES, AGENT_FREE_BLOCK_BYTES);
  }
  evaluate('Docker root', facts.dockerRoot.freeBytes, DOCKER_ROOT_FREE_WARN_BYTES, DOCKER_ROOT_FREE_BLOCK_BYTES);

  if (status === 'pass') {
    return {
      ...base,
      status,
      summary: 'All related filesystems have enough free space.',
      observed: `compose=${fmtBytes(compose.freeBytes)} agent=${fmtBytes(agent.freeBytes)} dockerRoot=${fmtBytes(facts.dockerRoot.freeBytes)}`,
    };
  }
  if (status === 'warn') {
    return {
      ...base,
      status,
      summary: `Free space is below the comfortable level. ${problems.join('; ')}.`,
      observed: problems.join('; '),
      remediation: 'Free space before approving execution, or choose a directory on a larger filesystem.',
    };
  }
  if (status === 'unknown') {
    return {
      ...base,
      status,
      summary: `Free space could not be read for at least one filesystem. ${problems.join('; ')}.`,
      observed: problems.join('; '),
      remediation: 'Check free space on the host, then run the preflight again.',
    };
  }
  return {
    ...base,
    status,
    summary: `Not enough free space. ${problems.join('; ')}.`,
    observed: problems.join('; '),
    remediation: 'Free space on the affected filesystem or choose a directory with at least the required headroom.',
  };
}

function persistenceCheck(facts: BootstrapFacts): BootstrapCheck {
  const base = { id: 'path_persistence' as const, category: 'storage' as const, label: 'Filesystem persistence' };
  const compose = facts.paths.composeDir;
  const agent = facts.paths.agentDir;
  const denied = [
    { name: 'Compose directory', type: compose.filesystem?.type ?? null },
    { name: 'Agent directory', type: agent.filesystem?.type ?? null },
  ].filter((entry) => isDeniedFilesystem(entry.type));
  if (denied.length > 0) {
    return {
      ...base,
      status: 'blocked',
      summary: `${denied.map((entry) => entry.name).join(' and ')} ${denied.length === 1 ? 'is' : 'are'} on a volatile or network filesystem.`,
      observed: denied.map((entry) => `${entry.name}=${entry.type}`).join(' '),
      remediation: 'Choose a local persistent path, or use manual enrollment with an operator-managed mount.',
    };
  }
  const unknown = [compose, agent].filter((path) => path.filesystem === null);
  if (unknown.length > 0) {
    return {
      ...base,
      status: 'unknown',
      summary: 'The filesystem type could not be read for at least one directory.',
      observed: unknown.map((path) => path.input).join(', '),
      remediation: 'Confirm both directories are on local persistent storage, then run the preflight again.',
    };
  }
  const separate = [compose, agent].filter((path) => path.mountInFstab === false && path.filesystem?.mountPoint !== '/');
  if (separate.length > 0) {
    return {
      ...base,
      status: 'warn',
      summary: `${separate.map((path) => path.input).join(' and ')} ${separate.length === 1 ? 'is' : 'are'} on a separate mount that is not listed in /etc/fstab.`,
      observed: separate.map((path) => `${path.input} on ${path.filesystem?.mountPoint}`).join('; '),
      remediation: 'Confirm the mount is present at boot (a systemd mount unit is not visible in fstab), then run the preflight again.',
    };
  }
  return {
    ...base,
    status: 'pass',
    summary: 'Both directories are on local persistent filesystems.',
    observed: `compose=${compose.filesystem?.type} agent=${agent.filesystem?.type}`,
  };
}

function agentConflictCheck(facts: BootstrapFacts): BootstrapCheck {
  const base = { id: 'agent_conflict' as const, category: 'conflicts' as const, label: 'Existing Pilot agent' };
  if (facts.agent.projectContainers.length > 0) {
    return {
      ...base,
      status: 'blocked',
      summary: `A ${PILOT_PROJECT_NAME} container already exists on this host.`,
      observed: facts.agent.projectContainers.map((row) => `${row.name} (${row.status})`).join(', '),
      remediation: 'Choose another host, or remove the existing Pilot deliberately before running this workflow. Nothing is replaced automatically.',
    };
  }
  if (facts.agent.defaultDirHasComposeFile && !facts.paths.agentDir.exists) {
    return {
      ...base,
      status: 'blocked',
      summary: `${DEFAULT_AGENT_DIR} already holds a Pilot compose file from an earlier installation.`,
      observed: facts.paths.agentDir.input,
      remediation: `Remove or move the old installation at ${DEFAULT_AGENT_DIR}, or use manual enrollment for this host.`,
    };
  }
  if (facts.agent.dataVolumeExists === true) {
    return {
      ...base,
      status: 'warn',
      summary: `The ${PILOT_PROJECT_NAME} data volume already exists without a running project.`,
      observed: 'sencho-agent-data',
      remediation: 'The volume can carry a previous Pilot identity. Execution must verify the stored identity or require an explicit replace before reusing it.',
    };
  }
  if (facts.agent.dataVolumeExists === null) {
    return {
      ...base,
      status: 'unknown',
      summary: 'The Docker volume inventory could not be read, so a previous Pilot volume cannot be ruled out.',
      observed: 'docker volume inspect failed',
      remediation: 'Confirm on the host that no sencho-agent container or volume exists, then run the preflight again.',
    };
  }
  return {
    ...base,
    status: 'pass',
    summary: 'No existing Pilot container, project or data volume was found.',
    observed: 'none',
  };
}

export function buildBootstrapEvidence(input: { facts: BootstrapFacts; nodeNameTaken: boolean; targetName: string }): EvidenceResult {
  const { facts } = input;
  const checks: BootstrapCheck[] = [];

  checks.push({
    id: 'ssh_host_key',
    category: 'identity',
    label: 'SSH host key',
    status: 'pass',
    summary: 'The host key matches the fingerprint you reviewed.',
    observed: facts.hostKey.fingerprint,
  });
  checks.push({
    id: 'ssh_auth',
    category: 'identity',
    label: 'SSH authentication',
    status: 'pass',
    summary: `Public-key authentication succeeded as ${facts.target.username}.`,
    observed: facts.target.username,
  });

  const osSupported = facts.os
    ? facts.os.id === 'ubuntu' && ['22.04', '24.04'].includes(facts.os.versionId)
    : null;
  checks.push(osSupported === null ? {
    id: 'os_supported',
    category: 'host',
    label: 'Operating system',
    status: 'unknown',
    summary: 'The operating system could not be read.',
    remediation: 'Confirm the host runs Ubuntu 22.04 or 24.04, then run the preflight again.',
  } : osSupported ? {
    id: 'os_supported',
    category: 'host',
    label: 'Operating system',
    status: 'pass',
    summary: `${facts.os?.prettyName || facts.os?.id} is supported.`,
    observed: `${facts.os?.id} ${facts.os?.versionId}`,
  } : {
    id: 'os_supported',
    category: 'host',
    label: 'Operating system',
    status: 'blocked',
    summary: `${facts.os?.prettyName || facts.os?.id} is not supported by this release.`,
    observed: `${facts.os?.id} ${facts.os?.versionId}`,
    remediation: 'Use Ubuntu 22.04 or 24.04, or enroll the node manually.',
  });

  checks.push(facts.os === null ? {
    id: 'arch_supported',
    category: 'host',
    label: 'Architecture',
    status: 'unknown',
    summary: 'The architecture could not be read.',
    remediation: 'Confirm the host is x86_64, then run the preflight again.',
  } : facts.os.arch === 'x86_64' ? {
    id: 'arch_supported',
    category: 'host',
    label: 'Architecture',
    status: 'pass',
    summary: 'x86_64 is supported.',
    observed: facts.os.arch,
  } : {
    id: 'arch_supported',
    category: 'host',
    label: 'Architecture',
    status: 'blocked',
    summary: `${facts.os.arch} is not supported by this release.`,
    observed: facts.os.arch,
    remediation: 'Use an x86_64 host, or enroll the node manually.',
  });

  const skew = facts.clockSkewMs;
  checks.push(skew === null ? {
    id: 'clock_skew',
    category: 'host',
    label: 'Clock skew',
    status: 'unknown',
    summary: 'The host clock could not be read.',
    remediation: 'Confirm the host clock is synchronized, then run the preflight again.',
  } : skew <= 60_000 ? {
    id: 'clock_skew',
    category: 'host',
    label: 'Clock skew',
    status: 'pass',
    summary: 'The host clock is within a minute of this instance.',
    observed: `${Math.round(skew / 1000)}s`,
  } : skew <= 5 * 60_000 ? {
    id: 'clock_skew',
    category: 'host',
    label: 'Clock skew',
    status: 'warn',
    summary: 'The host clock is more than a minute off, which can break token validation.',
    observed: `${Math.round(skew / 1000)}s`,
    remediation: 'Synchronize the host clock before enrollment, then run the preflight again.',
  } : {
    id: 'clock_skew',
    category: 'host',
    label: 'Clock skew',
    status: 'blocked',
    summary: 'The host clock is more than five minutes off.',
    observed: `${Math.round(skew / 1000)}s`,
    remediation: 'Synchronize the host clock (timedatectl or an NTP client), then run the preflight again.',
  });

  const repoConfigured = facts.repo.dockerSourceConfigured && facts.repo.keyringPresent;
  const missingPackages = facts.packages.some((pkg) => pkg.installedVersion === null);
  const serviceNeedsChange = facts.docker.serviceActive !== true || facts.docker.serviceEnabled !== true;
  const needsSudo = !facts.docker.cliInstalled
    || !repoConfigured
    || missingPackages
    || serviceNeedsChange
    || (facts.paths.composeDir.exists === false && facts.paths.composeDir.parentWritableByUser === false)
    || (facts.paths.agentDir.exists === false && facts.paths.agentDir.parentWritableByUser === false);
  if (!facts.user) {
    checks.push({
      id: 'sudo',
      category: 'privileges',
      label: 'Privilege',
      status: 'unknown',
      summary: 'The SSH user could not be read.',
      remediation: 'Confirm the SSH user exists and has the access you expect, then run the preflight again.',
    });
  } else if (facts.user.isRoot || facts.user.sudoNonInteractive) {
    checks.push({
      id: 'sudo',
      category: 'privileges',
      label: 'Privilege',
      status: 'pass',
      summary: facts.user.isRoot ? 'The SSH user is root.' : 'Non-interactive sudo is available.',
      observed: facts.user.isRoot ? 'root' : `${facts.user.name} via sudo -n`,
    });
  } else {
    checks.push({
      id: 'sudo',
      category: 'privileges',
      label: 'Privilege',
      status: needsSudo ? 'blocked' : 'pass',
      summary: needsSudo
        ? 'This plan needs administrator privileges, and non-interactive sudo is not available.'
        : 'Non-interactive sudo is not available; the current plan does not need it.',
      observed: 'sudo -n true failed',
      ...(needsSudo
        ? { remediation: 'Grant the SSH user passwordless sudo, or choose directories the user can write and a host where Docker is already installed.' }
        : {}),
    } as BootstrapCheck);
  }

  checks.push(!facts.docker.cliInstalled ? {
    id: 'docker_cli',
    category: 'docker',
    label: 'Docker CLI',
    status: 'warn',
    summary: 'Docker is not installed; the plan installs it from the official repository.',
    observed: 'command -v docker returned nothing',
    remediation: 'No action is needed if the host is Ubuntu 22.04 or 24.04 with network access to download.docker.com.',
  } : {
    id: 'docker_cli',
    category: 'docker',
    label: 'Docker CLI',
    status: 'pass',
    summary: 'The Docker CLI is installed.',
    observed: facts.docker.serverVersion ?? 'installed',
  });

  if (!facts.docker.cliInstalled) {
    checks.push({
      id: 'docker_daemon',
      category: 'docker',
      label: 'Docker daemon',
      status: 'warn',
      summary: 'Docker is not installed, so the daemon cannot be reached yet. The plan installs and starts it.',
      remediation: 'No action is needed if the official Docker repository is reachable from the host.',
    });
  } else if (facts.docker.serverVersion) {
    checks.push({
      id: 'docker_daemon',
      category: 'docker',
      label: 'Docker daemon',
      status: facts.docker.socketAccess === 'sudo' ? 'warn' : 'pass',
      summary: facts.docker.socketAccess === 'sudo'
        ? `The Docker daemon answers only through sudo (${facts.docker.serverVersion}).`
        : `The Docker daemon answers (${facts.docker.serverVersion}).`,
      observed: facts.docker.socketAccess,
      ...(facts.docker.socketAccess === 'sudo'
        ? { remediation: 'The plan uses sudo for Docker commands. Add the SSH user to the docker group if you want direct access.' }
        : {}),
    } as BootstrapCheck);
  } else if (facts.docker.serviceActive === false) {
    checks.push({
      id: 'docker_daemon',
      category: 'docker',
      label: 'Docker daemon',
      status: 'warn',
      summary: 'Docker is installed but not running. The plan starts it.',
      remediation: 'No action is needed; the plan enables and starts the Docker service.',
    });
  } else {
    checks.push({
      id: 'docker_daemon',
      category: 'docker',
      label: 'Docker daemon',
      status: 'blocked',
      summary: 'Docker is installed but the daemon cannot be reached, directly or through sudo.',
      remediation: 'Start the Docker service and grant the SSH user access, then run the preflight again.',
    });
  }

  checks.push(facts.docker.composeVersion ? {
    id: 'compose_plugin',
    category: 'docker',
    label: 'Docker Compose',
    status: 'pass',
    summary: `The Compose plugin is available (${facts.docker.composeVersion}).`,
    observed: facts.docker.composeVersion,
  } : {
    id: 'compose_plugin',
    category: 'docker',
    label: 'Docker Compose',
    status: 'warn',
    summary: 'The Docker Compose plugin is missing. The plan installs it.',
    remediation: 'No action is needed if the official Docker repository is reachable from the host.',
  });

  if (!facts.docker.cliInstalled) {
    checks.push({
      id: 'docker_socket',
      category: 'docker',
      label: 'Docker socket access',
      status: 'warn',
      summary: 'Docker is not installed, so socket access cannot be checked yet.',
      remediation: 'No action is needed; the plan installs Docker and starts the agent as root through the socket.',
    });
  } else if (facts.docker.socketAccess === 'user') {
    checks.push({
      id: 'docker_socket',
      category: 'docker',
      label: 'Docker socket access',
      status: 'pass',
      summary: 'The SSH user can use the Docker socket directly.',
      observed: 'user',
    });
  } else if (facts.docker.socketAccess === 'sudo') {
    checks.push({
      id: 'docker_socket',
      category: 'docker',
      label: 'Docker socket access',
      status: 'warn',
      summary: 'The Docker socket is reachable only through sudo.',
      observed: 'sudo',
      remediation: 'The plan uses sudo for Docker commands. Add the SSH user to the docker group if you want direct access.',
    });
  } else {
    checks.push({
      id: 'docker_socket',
      category: 'docker',
      label: 'Docker socket access',
      status: 'blocked',
      summary: 'The Docker socket is not accessible directly or through sudo.',
      remediation: 'Grant the SSH user access to the Docker socket, then run the preflight again.',
    });
  }

  checks.push(facts.repo.dockerSourceConfigured && facts.repo.keyringPresent ? {
    id: 'apt_source',
    category: 'docker',
    label: 'Docker package source',
    status: 'pass',
    summary: 'The official Docker repository and keyring are configured.',
    observed: 'docker.list or docker.sources plus a keyring',
  } : facts.packages.every((pkg) => pkg.installedVersion === null) && !facts.docker.cliInstalled ? {
    id: 'apt_source',
    category: 'docker',
    label: 'Docker package source',
    status: 'warn',
    summary: 'The official Docker repository is not configured. The plan adds it.',
    remediation: 'No action is needed if the host can reach download.docker.com.',
  } : {
    id: 'apt_source',
    category: 'docker',
    label: 'Docker package source',
    status: 'unknown',
    summary: 'The Docker package source could not be read.',
    remediation: 'Confirm the host uses the official Docker repository, then run the preflight again.',
  });

  checks.push(diskSpaceCheck(facts));
  checks.push(persistenceCheck(facts));
  checks.push(composeDirCheck(facts.paths.composeDir, facts));
  checks.push(agentDirCheck(facts.paths.agentDir, facts, facts.paths.composeDir.input));

  const resolvedCompose = facts.paths.composeDir.realPath ?? facts.paths.composeDir.normalized;
  const resolvedAgent = facts.paths.agentDir.realPath ?? facts.paths.agentDir.normalized;
  const separation = arePathsDisjoint(resolvedCompose, resolvedAgent);
  checks.push(separation.ok ? {
    id: 'path_separation',
    category: 'paths',
    label: 'Directory separation',
    status: 'pass',
    summary: 'The two directories are separate paths.',
    observed: `${resolvedCompose} / ${resolvedAgent}`,
  } : {
    id: 'path_separation',
    category: 'paths',
    label: 'Directory separation',
    status: 'blocked',
    summary: separation.reason === 'equal'
      ? 'The two directories are the same path.'
      : separation.reason === 'agent-inside-compose'
        ? 'The Agent directory is inside the Compose directory, so it would appear as a stack.'
        : 'The Compose directory is inside the Agent directory, so its stacks would be hidden.',
    observed: `${resolvedCompose} / ${resolvedAgent}`,
    remediation: 'Choose two directories that are neither equal nor nested, for example /opt/docker/sencho and /opt/sencho-agent.',
  });

  checks.push(agentConflictCheck(facts));

  checks.push(!facts.docker.cliInstalled ? {
    id: 'existing_workloads',
    category: 'conflicts',
    label: 'Existing workloads',
    status: 'unknown',
    summary: 'Docker is not installed, so there are no workloads to inventory yet.',
    remediation: 'This is expected on a fresh host. No action is needed.',
  } : {
    id: 'existing_workloads',
    category: 'conflicts',
    label: 'Existing workloads',
    status: 'pass',
    summary: `${facts.containers.total} existing container${facts.containers.total === 1 ? '' : 's'} will be left untouched.`,
    observed: facts.containers.sample.slice(0, 5).map((row) => row.name).join(', ') || 'none',
  });

  checks.push(input.nodeNameTaken ? {
    id: 'node_name',
    category: 'network',
    label: 'Node name',
    status: 'blocked',
    summary: `A node named ${input.targetName} already exists in this console.`,
    remediation: 'Choose a different node name, or edit the existing node instead.',
  } : {
    id: 'node_name',
    category: 'network',
    label: 'Node name',
    status: 'pass',
    summary: 'The node name is available.',
  });

  const hubUrl = validateHubUrl(facts.hub.url);
  checks.push(!hubUrl.ok ? {
    id: 'hub_url',
    category: 'network',
    label: 'Hub URL',
    status: 'blocked',
    summary: hubUrl.reason ?? 'The hub URL is not valid.',
    observed: facts.hub.url,
    remediation: 'Set SENCHO_PUBLIC_URL to the URL the target can reach, then run the preflight again.',
  } : hubUrl.loopback ? {
    id: 'hub_url',
    category: 'network',
    label: 'Hub URL',
    status: 'blocked',
    summary: 'The hub URL points at loopback, which the target cannot reach.',
    observed: facts.hub.url,
    remediation: 'Set SENCHO_PUBLIC_URL to this instance\'s reachable LAN or public URL, then run the preflight again.',
  } : facts.hub.url.startsWith('http://') ? {
    id: 'hub_url',
    category: 'network',
    label: 'Hub URL',
    status: 'warn',
    summary: 'The hub URL uses plain HTTP, so the node token and tunnel are not encrypted in transit.',
    observed: facts.hub.url,
    remediation: 'Serve Sencho over HTTPS, or keep the target and the hub on a trusted private network.',
  } : {
    id: 'hub_url',
    category: 'network',
    label: 'Hub URL',
    status: 'pass',
    summary: 'The hub URL is a reachable HTTPS address.',
    observed: facts.hub.url,
  });

  checks.push(facts.hub.reachable === null ? {
    id: 'hub_reachable',
    category: 'network',
    label: 'Hub reachability',
    status: 'unknown',
    summary: 'Hub reachability could not be measured from the target (curl is unavailable or the check timed out).',
    remediation: 'Confirm the target can reach the hub URL over HTTPS, then run the preflight again.',
  } : facts.hub.tlsTrusted === false ? {
    id: 'hub_reachable',
    category: 'network',
    label: 'Hub reachability',
    status: 'warn',
    summary: 'The target reached the hub, but does not trust its TLS certificate.',
    observed: `HTTP ${facts.hub.statusCode ?? 'unavailable'}`,
    remediation: 'The Pilot uses the hub CA written next to its compose file. If you use a private CA, confirm the certificate chain.',
  } : facts.hub.reachable ? {
    id: 'hub_reachable',
    category: 'network',
    label: 'Hub reachability',
    status: 'pass',
    summary: `The target reached the hub (HTTP ${facts.hub.statusCode}).`,
    observed: `HTTP ${facts.hub.statusCode}`,
  } : {
    id: 'hub_reachable',
    category: 'network',
    label: 'Hub reachability',
    status: 'blocked',
    summary: 'The target could not reach the hub URL.',
    remediation: 'Open outbound HTTPS from the target to the hub, or set SENCHO_PUBLIC_URL to an address the target can reach.',
  });

  const blockers = checks.filter((check) => check.status === 'blocked').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const planSuppressed = checks.some((check) => PATH_CHECK_IDS.has(check.id) && check.status === 'unknown');
  return { checks, blockers, warnings, planSuppressed };
}
