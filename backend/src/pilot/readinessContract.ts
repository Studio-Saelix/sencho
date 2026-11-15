/**
 * The Pilot readiness contract: what a Pilot agent reports about itself when
 * the hub asks whether it can run deployments.
 *
 * The hub sends a fresh nonce through the Pilot tunnel; the agent answers
 * with read-only facts about its own identity, its Docker engine, Compose,
 * the Compose directory and a container inventory. The hub judges the report
 * (see `services/nodeBootstrap/readinessGates.ts`); the agent never decides
 * that it is ready. This module holds the shape both sides share and the
 * parser the hub applies to an answer it did not produce, so a missing,
 * mistyped, over-long or duplicated field is refused instead of trusted. Keys
 * it does not know are ignored, and a check the report leaves out is judged
 * unknown by the hub.
 */

export const READINESS_CONTRACT_VERSION = 1;

/** The agent's own route. Reached only by the hub through the tunnel. */
export const READINESS_PATH = '/api/pilot/readiness';

/** Compose project and volume of the canonical Pilot (see `helpers/pilotEnrollmentCompose.ts`). */
export const PILOT_PROJECT_NAME = 'sencho-agent';
export const PILOT_DATA_VOLUME = 'sencho-agent-data';
export const PILOT_DATA_MOUNT = '/app/data';

export type ReadinessCheckId =
  | 'docker_socket'
  | 'docker_compose'
  | 'compose_dir'
  | 'self_stack_location'
  | 'path_mapping'
  | 'disk_space';

export const REPORTED_CHECK_IDS: readonly ReadinessCheckId[] = [
  'docker_socket',
  'docker_compose',
  'compose_dir',
  'self_stack_location',
  'path_mapping',
  'disk_space',
];

export interface ReportedCheck {
  id: ReadinessCheckId;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  remediation: string | null;
}

export interface PilotReadinessReport {
  contract: number;
  nonce: string;
  /** The agent's clock, in epoch milliseconds, when it built the report. */
  generatedAt: number;
  agent: {
    version: string;
    /** The node id inside the agent's hub-signed tunnel credential, or null when it holds none. */
    enrolledNodeId: number | null;
    /** The hub URL the agent dials. */
    primaryUrl: string | null;
    /** Whether the agent trusts a hub CA bundle. */
    caBundle: boolean;
  };
  docker: {
    serverVersion: string | null;
    apiVersion: string | null;
  };
  composeDir: string;
  checks: ReportedCheck[];
  inventory: {
    /** Whether listing containers succeeded. */
    listed: boolean;
    containers: number | null;
    /** The canonical Pilot container was found in the listing. */
    agentContainer: boolean | null;
    /** That container keeps its data in the canonical Pilot volume. */
    agentDataVolume: boolean | null;
  };
}

const MAX_TEXT = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function nullableText(value: unknown, max = MAX_TEXT): string | null | undefined {
  if (value === null) return null;
  const parsed = text(value, max);
  return parsed === null ? undefined : parsed;
}

function nullableBool(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === 'boolean' ? value : undefined;
}

function parseCheck(value: unknown): ReportedCheck | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== 'string' || !(REPORTED_CHECK_IDS as readonly string[]).includes(id)) return null;
  const status = value.status;
  if (status !== 'pass' && status !== 'warn' && status !== 'fail') return null;
  const detail = text(value.detail);
  const remediation = nullableText(value.remediation);
  if (detail === null || remediation === undefined) return null;
  return { id: id as ReadinessCheckId, status, detail, remediation };
}

/** Parse an agent's answer. Returns null for anything missing a required field, mistyped, over-long or duplicated. */
export function parseReadinessReport(value: unknown): PilotReadinessReport | null {
  if (!isRecord(value)) return null;
  if (value.contract !== READINESS_CONTRACT_VERSION) return null;
  const nonce = text(value.nonce, 128);
  if (!nonce || typeof value.generatedAt !== 'number' || !Number.isSafeInteger(value.generatedAt)) return null;
  const agent = value.agent;
  const docker = value.docker;
  const inventory = value.inventory;
  if (!isRecord(agent) || !isRecord(docker) || !isRecord(inventory) || !Array.isArray(value.checks)) return null;

  const version = text(agent.version, 64);
  const enrolledNodeId = agent.enrolledNodeId === null
    ? null
    : (typeof agent.enrolledNodeId === 'number' && Number.isSafeInteger(agent.enrolledNodeId) ? agent.enrolledNodeId : undefined);
  const primaryUrl = nullableText(agent.primaryUrl, 2048);
  if (version === null || enrolledNodeId === undefined || primaryUrl === undefined || typeof agent.caBundle !== 'boolean') return null;

  const serverVersion = nullableText(docker.serverVersion, 64);
  const apiVersion = nullableText(docker.apiVersion, 64);
  if (serverVersion === undefined || apiVersion === undefined) return null;

  const composeDir = text(value.composeDir, 4096);
  if (composeDir === null) return null;

  if (value.checks.length > REPORTED_CHECK_IDS.length) return null;
  const checks: ReportedCheck[] = [];
  for (const raw of value.checks) {
    const check = parseCheck(raw);
    if (!check || checks.some((seen) => seen.id === check.id)) return null;
    checks.push(check);
  }

  if (typeof inventory.listed !== 'boolean') return null;
  const containers = inventory.containers === null
    ? null
    : (typeof inventory.containers === 'number' && Number.isSafeInteger(inventory.containers) && inventory.containers >= 0 ? inventory.containers : undefined);
  const agentContainer = nullableBool(inventory.agentContainer);
  const agentDataVolume = nullableBool(inventory.agentDataVolume);
  if (containers === undefined || agentContainer === undefined || agentDataVolume === undefined) return null;

  return {
    contract: READINESS_CONTRACT_VERSION,
    nonce,
    generatedAt: value.generatedAt,
    agent: { version, enrolledNodeId, primaryUrl, caBundle: agent.caBundle },
    docker: { serverVersion, apiVersion },
    composeDir,
    checks,
    inventory: { listed: inventory.listed, containers, agentContainer, agentDataVolume },
  };
}
