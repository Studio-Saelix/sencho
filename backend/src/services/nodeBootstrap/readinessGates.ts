import type { PilotReadinessReport, ReadinessCheckId, ReportedCheck } from '../../pilot/readinessContract';

/**
 * The hub's verdict on a Pilot's readiness report.
 *
 * Pure: the IO lives in `NodeReadinessService`. Every gate fails closed. A
 * fact the report does not carry, or carries in a shape this build does not
 * know, is `unknown`, and `unknown` blocks Ready the same as `fail`. Only
 * `warn` lets the node be ready, for facts that do not stop a deployment
 * (a plain-HTTP hub the operator chose, a disk that is getting full).
 */

export type ReadinessGateId =
  | 'tunnel'
  | 'contract'
  | 'identity'
  | 'hub_url'
  | 'transport'
  | 'clock'
  | 'agent_version'
  | 'docker_daemon'
  | 'docker_compose'
  | 'compose_dir'
  | 'path_mapping'
  | 'self_stack_location'
  | 'disk_space'
  | 'inventory';

interface GateBase {
  id: ReadinessGateId;
  label: string;
  summary: string;
}

/** A pass carries no remediation; every other verdict must carry one. */
export type ReadinessGate =
  | (GateBase & { status: 'pass' })
  | (GateBase & { status: 'warn' | 'fail' | 'unknown'; remediation: string });

export type ReadinessVerdict = 'ready' | 'not_ready';

export interface ReadinessResult {
  verdict: ReadinessVerdict;
  gates: ReadinessGate[];
}

/** Clock skew past this stops token validation working reliably; it matches the preflight's block threshold. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface ReadinessExpectation {
  nodeId: number;
  nonce: string;
  /** The hub URL the bootstrap plan configured the Pilot with. */
  hubUrl: string;
  /** The node's Compose directory as the hub records it. */
  composeDir: string;
  /** The agent version the tunnel's handshake announced. */
  tunnelAgentVersion: string | null;
  tunnelConfidential: boolean;
  /** Hub clock when the request was sent and when the answer arrived. */
  requestedAt: number;
  receivedAt: number;
}

/** Why no report could be judged. Each one maps to its own gate so the operator sees the cause, not a generic failure. */
export type ReadinessFailure =
  | { kind: 'not_connected' }
  | { kind: 'unsupported'; status: number }
  | { kind: 'refused'; status: number }
  | { kind: 'malformed' }
  | { kind: 'unreachable'; message: string };

const LABELS: Record<ReadinessGateId, string> = {
  tunnel: 'Pilot tunnel',
  contract: 'Readiness report',
  identity: 'Node identity',
  hub_url: 'Hub URL',
  transport: 'Tunnel transport',
  clock: 'Clock skew',
  agent_version: 'Agent version',
  docker_daemon: 'Docker engine',
  docker_compose: 'Docker Compose',
  compose_dir: 'Compose directory',
  path_mapping: 'Compose directory mount',
  self_stack_location: 'Pilot project location',
  disk_space: 'Free disk space',
  inventory: 'Container inventory',
};

function pass(id: ReadinessGateId, summary: string): ReadinessGate {
  return { id, label: LABELS[id], status: 'pass', summary };
}

function notPass(id: ReadinessGateId, status: 'warn' | 'fail' | 'unknown', summary: string, remediation: string): ReadinessGate {
  return { id, label: LABELS[id], status, summary, remediation };
}

function verdictOf(gates: ReadinessGate[]): ReadinessVerdict {
  return gates.every((gate) => gate.status === 'pass' || gate.status === 'warn') ? 'ready' : 'not_ready';
}

/** Compare URLs by origin and path, so a trailing slash or letter case in the host does not read as a different hub. */
export function sameHubUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, '');
    return left.origin === right.origin && path(left) === path(right);
  } catch {
    return false;
  }
}

/** The verdict when the agent could not be asked at all. */
export function readinessWithoutReport(failure: ReadinessFailure): ReadinessResult {
  const gate = ((): ReadinessGate => {
    switch (failure.kind) {
      case 'not_connected':
        return notPass('tunnel', 'fail', 'The Pilot is not connected to the hub, so nothing on the host could be verified.',
          'Check that the sencho-agent container is running on the host and can reach the hub URL, then verify again.');
      case 'unsupported':
        return notPass('contract', 'fail', `The Pilot answered ${failure.status}: its image does not provide the readiness report this hub needs.`,
          'Update the Pilot to the same Sencho release as the hub (pull the image and recreate the sencho-agent project), then verify again.');
      case 'refused':
        return notPass('contract', 'fail', `The Pilot refused the readiness request (${failure.status}).`,
          'Re-enroll the node so the Pilot and the hub share a current credential, then verify again.');
      case 'malformed':
        return notPass('contract', 'unknown', 'The Pilot\'s answer was not a readiness report this hub can read.',
          'Update the Pilot to the same Sencho release as the hub, then verify again.');
      case 'unreachable':
        return notPass('tunnel', 'unknown', `The readiness request did not complete: ${failure.message}`,
          'Check the tunnel in Fleet and the hub logs, then verify again.');
    }
  })();
  // A tunnel that did not carry the request is the one gate; a tunnel that did carry it passed, and the answer is what failed.
  const gates = gate.id === 'tunnel' ? [gate] : [pass('tunnel', 'The Pilot tunnel is connected.'), gate];
  return { verdict: 'not_ready', gates };
}

function reported(report: PilotReadinessReport, id: ReadinessCheckId): ReportedCheck | null {
  return report.checks.find((check) => check.id === id) ?? null;
}

/** Map a check the agent ran on itself. A missing row is unknown, a warn on a fact that decides deployments fails. */
function fromReported(
  report: PilotReadinessReport,
  id: ReadinessCheckId & ReadinessGateId,
  warnBlocks: boolean,
  missingRemediation: string,
): ReadinessGate {
  const check = reported(report, id);
  if (!check) return notPass(id, 'unknown', 'The Pilot did not report this check.', missingRemediation);
  if (check.status === 'pass') return pass(id, check.detail);
  const remediation = check.remediation ?? missingRemediation;
  if (check.status === 'warn' && !warnBlocks) return notPass(id, 'warn', check.detail, remediation);
  return notPass(id, check.status === 'fail' ? 'fail' : 'unknown', check.detail, remediation);
}

export function evaluateReadiness(report: PilotReadinessReport, expected: ReadinessExpectation): ReadinessResult {
  const gates: ReadinessGate[] = [pass('tunnel', 'The Pilot tunnel is connected and answered this request.')];

  gates.push(report.nonce === expected.nonce
    ? pass('contract', 'The report answers this request.')
    : notPass('contract', 'fail', 'The report does not answer this request (its nonce differs), so it may be stale or relayed.',
      'Verify again. If it repeats, re-enroll the node.'));

  const enrolled = report.agent.enrolledNodeId;
  gates.push(enrolled === expected.nodeId
    ? pass('identity', `The Pilot holds the credential for node ${expected.nodeId}.`)
    : enrolled === null
      ? notPass('identity', 'fail', 'The Pilot holds no saved hub credential, so its enrollment did not complete.',
        'Regenerate the enrollment for this node and restart the sencho-agent project with the new token.')
      : notPass('identity', 'fail', `The Pilot is enrolled as node ${enrolled}, not node ${expected.nodeId}.`,
        'This host belongs to another node record. Remove the duplicate node, or re-enroll this host for this node.'));

  const primaryUrl = report.agent.primaryUrl;
  gates.push(primaryUrl !== null && sameHubUrl(primaryUrl, expected.hubUrl)
    ? pass('hub_url', `The Pilot dials ${expected.hubUrl}.`)
    : notPass('hub_url', 'fail', primaryUrl === null
      ? 'The Pilot reports no hub URL.'
      : `The Pilot dials ${primaryUrl}, not the hub URL the bootstrap configured (${expected.hubUrl}).`,
    'Set SENCHO_PRIMARY_URL in the sencho-agent project to the hub URL, recreate it, then verify again.'));

  const httpsHub = expected.hubUrl.startsWith('https:');
  gates.push(expected.tunnelConfidential
    ? pass('transport', report.agent.caBundle ? 'The tunnel runs over TLS, trusted through the hub CA bundle.' : 'The tunnel runs over TLS.')
    : httpsHub
      ? notPass('transport', 'fail', 'The hub URL is HTTPS, but this tunnel did not arrive over TLS.',
        'Check the reverse proxy in front of the hub: it must pass the TLS connection or set the forwarded protocol header, then verify again.')
      : notPass('transport', 'warn', 'The tunnel runs over plain HTTP, so its traffic is not encrypted.',
        'Serve the hub over HTTPS and re-enroll the node to encrypt the tunnel.'));

  const midpoint = (expected.requestedAt + expected.receivedAt) / 2;
  const skew = Math.abs(report.generatedAt - midpoint);
  gates.push(skew <= MAX_CLOCK_SKEW_MS
    ? pass('clock', `The host clock is within ${Math.max(1, Math.round(skew / 1000))}s of the hub.`)
    : notPass('clock', 'fail', `The host clock is ${Math.round(skew / 1000)}s off the hub, which breaks token checks.`,
      'Synchronize the host clock (timedatectl or an NTP client), then verify again.'));

  const version = report.agent.version;
  gates.push(expected.tunnelAgentVersion !== null && version === expected.tunnelAgentVersion
    ? pass('agent_version', `Pilot ${version} answered on the tunnel that announced it.`)
    : notPass('agent_version', 'fail', expected.tunnelAgentVersion === null
      ? 'The tunnel did not announce an agent version, so the answering agent cannot be matched to it.'
      : `The report came from Pilot ${version}, but the tunnel announced ${expected.tunnelAgentVersion}.`,
    'The agent may have restarted or updated during the check. Verify again once it has reconnected.'));

  const socket = reported(report, 'docker_socket');
  const daemonWorks = socket?.status === 'pass' && report.docker.serverVersion !== null && report.docker.apiVersion !== null;
  gates.push(daemonWorks
    ? pass('docker_daemon', `Docker Engine ${report.docker.serverVersion} (API ${report.docker.apiVersion}) answered through the mounted socket.`)
    : notPass('docker_daemon', socket?.status === 'fail' ? 'fail' : 'unknown',
      socket?.status === 'fail' ? socket.detail : 'The Pilot could not read the Docker engine version.',
      socket?.remediation ?? 'Check that /var/run/docker.sock is mounted into the sencho-agent container and the Docker service is running.'));

  gates.push(fromReported(report, 'docker_compose', true, 'Install the Docker Compose v2 plugin on the host, then verify again.'));

  const dirCheck = fromReported(report, 'compose_dir', true, 'Check that the Compose directory exists and is writable inside the sencho-agent container.');
  gates.push(report.composeDir === expected.composeDir
    ? dirCheck
    : notPass('compose_dir', 'fail', `The Pilot manages ${report.composeDir}, but this node records ${expected.composeDir}.`,
      'Set COMPOSE_DIR in the sencho-agent project to the node\'s Compose directory and bind-mount it at the same path, then verify again.'));

  gates.push(fromReported(report, 'path_mapping', true, 'Bind-mount the Compose directory into the sencho-agent container at the same path.'));
  gates.push(fromReported(report, 'self_stack_location', true, 'Keep the sencho-agent project outside the Compose directory.'));
  gates.push(fromReported(report, 'disk_space', false, 'Free disk space on the host.'));

  const inventory = report.inventory;
  gates.push(!inventory.listed
    ? notPass('inventory', 'fail', 'The Pilot could not list containers through Docker.',
      'Check that the sencho-agent container can use the Docker socket, then verify again.')
    : inventory.agentContainer !== true
      ? notPass('inventory', 'fail', 'The listing does not show the sencho-agent container, so the answering agent is not the canonical Pilot.',
        'Run the Pilot from the sencho-agent Compose project the bootstrap wrote, then verify again.')
      : inventory.agentDataVolume !== true
        ? notPass('inventory', 'fail', 'The sencho-agent container does not keep its data in the sencho-agent-data volume, so its credential would not survive a recreate.',
          'Recreate the sencho-agent project from the compose file the bootstrap wrote.')
        : pass('inventory', `Listed ${inventory.containers ?? 0} container${inventory.containers === 1 ? '' : 's'}, including the sencho-agent container with its data volume.`));

  return { verdict: verdictOf(gates), gates };
}
