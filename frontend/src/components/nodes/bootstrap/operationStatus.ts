import type { StatusPathAnswer, StatusPathStage } from '@/components/ui/status-path';
import type { StatusTone } from '@/lib/statusTone';
import type { BootstrapOperation, BootstrapOperationDetail, BootstrapOperationState, NodeReadiness, ReadinessGate } from './types';

/**
 * Maps a bootstrap operation onto the Answer and Path of `StatusPath`.
 *
 * The Answer is the operation's state in one sentence. The Path groups the
 * plan's stages into the phases an operator recognizes (recheck, Docker, Pilot
 * files, start, enrollment, readiness); a phase the plan does not contain is
 * omitted. An enrolled run is not the end: its Answer is the hub's readiness
 * verdict for the node, and only a verdict of ready reads as ready.
 */

const RUNNING_STATES: readonly BootstrapOperationState[] = ['rechecking', 'running', 'enrolling'];

export function isOperationRunning(op: Pick<BootstrapOperation, 'state'>): boolean {
  return RUNNING_STATES.includes(op.state);
}

/**
 * Stopped states the hub can still settle on a read: a Pilot that connects after
 * the run gave up (or was cancelled or interrupted) turns the run into `enrolled`
 * the next time it is read. Mirrors the backend's reconcilable states, and its
 * other conditions: the run must still hold its server, have registered a node
 * and have started the Pilot, or nothing can connect.
 */
const SETTLEABLE_STATES: readonly BootstrapOperationState[] = ['partial', 'outcome_unknown', 'cancelled'];

export function canSettleOnRead(op: Pick<BootstrapOperation, 'state' | 'active' | 'nodeId' | 'agentStarted'>): boolean {
  return op.active && op.nodeId !== null && op.agentStarted && SETTLEABLE_STATES.includes(op.state);
}

/** An enrolled run whose node the hub has not finished checking; the dialog reads it again until the verdict lands. */
export function awaitsReadiness(op: Pick<BootstrapOperation, 'state' | 'readiness'>): boolean {
  return op.state === 'enrolled' && (op.readiness?.state === 'provisional' || op.readiness?.state === 'verifying');
}

/** The gates that keep a node from ready: failed first, then the ones whose evidence was unknown. */
export function blockingGates(readiness: Pick<NodeReadiness, 'gates'>): ReadinessGate[] {
  const order = { fail: 0, unknown: 1, warn: 2, pass: 3 } as const;
  return readiness.gates
    .filter((gate) => gate.status === 'fail' || gate.status === 'unknown')
    .sort((a, b) => order[a.status] - order[b.status]);
}

type Phase = 'recheck' | 'docker' | 'files' | 'start' | 'enroll' | 'verify';

const PHASE_LABEL: Record<Phase, string> = {
  recheck: 'recheck',
  docker: 'docker',
  files: 'pilot files',
  start: 'start',
  enroll: 'enroll',
  verify: 'readiness',
};

const STAGE_PHASE: Record<string, Phase> = {
  recheck: 'recheck',
  docker_repository: 'docker',
  docker_packages: 'docker',
  docker_service: 'docker',
  compose_dir: 'files',
  agent_dir: 'files',
  agent_project: 'files',
  agent_start: 'start',
  enroll: 'enroll',
};

const ORDER: Phase[] = ['recheck', 'docker', 'files', 'start', 'enroll', 'verify'];

function phasesIn(op: BootstrapOperationDetail): Phase[] {
  const present = new Set<Phase>(['recheck', 'enroll', 'verify']);
  for (const stage of op.plan.stages) {
    const phase = STAGE_PHASE[stage.id];
    if (phase) present.add(phase);
  }
  return ORDER.filter((phase) => present.has(phase));
}

/** The phase the operation reached; a run still rechecking has not recorded a stage yet. */
function currentPhase(op: BootstrapOperationDetail): Phase {
  if (op.state === 'enrolled') return 'enroll';
  return (op.stage && STAGE_PHASE[op.stage]) || 'recheck';
}

function stepTitle(op: BootstrapOperationDetail): string | null {
  if (!op.step) return null;
  for (const stage of op.plan.stages) {
    const step = stage.steps.find((entry) => entry.id === op.step);
    if (step) return step.title;
  }
  return null;
}

const STOPPED: Record<Exclude<BootstrapOperationState, 'rechecking' | 'running' | 'enrolling'>, { tone: StatusTone; title: string; word: string }> = {
  enrolled: { tone: 'success', title: 'Enrolled', word: 'connected' },
  blocked: { tone: 'warning', title: 'Blocked', word: 'blocked' },
  failed: { tone: 'destructive', title: 'Failed', word: 'failed' },
  partial: { tone: 'warning', title: 'Stopped partway', word: 'stopped' },
  cancelled: { tone: 'neutral', title: 'Cancelled', word: 'cancelled' },
  outcome_unknown: { tone: 'warning', title: 'Outcome unknown', word: 'unknown' },
  recovery_required: { tone: 'destructive', title: 'Needs recovery', word: 'needs recovery' },
};

/** The wording for a stopped state, with a neutral fallback for a state this build does not know. */
function stoppedState(state: BootstrapOperationState): { tone: StatusTone; title: string; word: string } {
  return (STOPPED as Partial<Record<BootstrapOperationState, { tone: StatusTone; title: string; word: string }>>)[state]
    ?? { tone: 'neutral', title: 'Stopped', word: 'stopped' };
}

export function operationAnswer(op: BootstrapOperationDetail): Omit<StatusPathAnswer, 'action'> {
  if (op.state === 'rechecking') {
    return { tone: 'brand', title: 'Re-checking', status: op.state, line: 'Re-checking the host against the approved plan. Nothing has been changed yet.' };
  }
  if (op.state === 'running') {
    const title = stepTitle(op);
    const line = title ? `Running: ${title}.` : 'Running the approved plan.';
    return {
      tone: 'brand',
      title: 'Running',
      status: op.state,
      line: op.cancelRequested ? `${line} The run stops after this step.` : line,
    };
  }
  if (op.state === 'enrolling') {
    return {
      tone: 'brand',
      title: 'Enrolling',
      status: op.state,
      line: op.cancelRequested ? 'Stopping the wait for the Pilot.' : 'The Pilot is running. Waiting for it to connect with its enrollment.',
    };
  }
  const stopped = stoppedState(op.state);
  if (op.state === 'enrolled') return readinessAnswer(op);
  return {
    tone: stopped.tone,
    title: stopped.title,
    status: op.state,
    line: op.error?.message || 'The run stopped.',
    detail: op.changesMade && op.state !== 'outcome_unknown' && op.state !== 'blocked'
      ? 'Steps that ran stay on the host. Nothing was undone.'
      : null,
  };
}

function checkedAt(at: number | null): string {
  return at === null ? '' : ` at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The Answer for an enrolled run: the hub's readiness verdict for its node, never the connection alone. */
function readinessAnswer(op: BootstrapOperationDetail): Omit<StatusPathAnswer, 'action'> {
  const readiness = op.readiness;
  if (!readiness) {
    return {
      tone: 'neutral',
      title: 'Enrolled',
      status: 'enrolled',
      line: `${op.targetName} is enrolled. This run no longer speaks for the node's readiness: a later enrollment replaced it, or the node was removed.`,
    };
  }
  switch (readiness.state) {
    case 'provisional':
      return { tone: 'brand', title: 'Connected, unverified', status: 'provisional', line: `The Pilot on ${op.targetName} is enrolled. The hub checks it for readiness once its tunnel is up.` };
    case 'verifying':
      return { tone: 'brand', title: 'Verifying', status: 'verifying', line: `Checking the Pilot on ${op.targetName}: identity, Docker, Compose and the Compose directory.` };
    case 'ready':
      return {
        tone: 'success',
        title: 'Ready',
        status: 'ready',
        line: `${op.targetName} passed every readiness check${checkedAt(readiness.checkedAt)}. It is ready for deployments.`,
      };
    case 'not_ready': {
      const [first, ...rest] = blockingGates(readiness);
      return {
        tone: 'warning',
        title: 'Connected, unverified',
        status: 'not_ready',
        line: first ? `${first.label}: ${first.summary}` : `${op.targetName} did not pass the readiness check.`,
        detail: [first?.remediation, rest.length > 0 ? `${rest.length} more check${rest.length === 1 ? '' : 's'} failed.` : null].filter(Boolean).join(' ') || null,
      };
    }
  }
}

const READINESS_STAGE: Record<NodeReadiness['state'], Pick<StatusPathStage, 'tone' | 'word'>> = {
  provisional: { tone: 'neutral', word: 'pending' },
  verifying: { tone: 'brand', word: 'checking' },
  ready: { tone: 'success', word: 'ready' },
  not_ready: { tone: 'warning', word: 'unverified' },
};

export function operationStages(op: BootstrapOperationDetail): StatusPathStage[] {
  const phases = phasesIn(op);
  const reached = phases.indexOf(currentPhase(op));
  const running = isOperationRunning(op);
  const stopped = running ? null : stoppedState(op.state);
  return phases.map((phase, index): StatusPathStage => {
    const base = { id: phase, label: PHASE_LABEL[phase], 'data-testid': `bootstrap-phase-${phase}` };
    if (op.state === 'enrolled') {
      if (phase !== 'verify') return { ...base, tone: 'success', word: phase === 'enroll' ? 'connected' : 'done', status: 'done' };
      const state = op.readiness?.state;
      return state ? { ...base, ...READINESS_STAGE[state], status: state } : { ...base, tone: 'neutral', word: 'not recorded', status: 'unknown' };
    }
    if (index < reached) return { ...base, tone: 'success', word: 'done', status: 'done' };
    if (index === reached) {
      if (running) return { ...base, tone: 'brand', word: phase === 'enroll' ? 'waiting' : 'running', status: 'running' };
      return { ...base, tone: stopped?.tone ?? 'neutral', word: stopped?.word ?? 'stopped', status: op.state };
    }
    return { ...base, tone: 'neutral', word: running ? 'pending' : 'not run', status: 'pending' };
  });
}

/** The state word for a compact row in the operations list. */
export function operationStateWord(op: Pick<BootstrapOperation, 'state' | 'readiness'>): { tone: StatusTone; word: string } {
  if (op.state === 'enrolled' && op.readiness) {
    const words = { provisional: 'Unverified', verifying: 'Verifying', ready: 'Ready', not_ready: 'Unverified' } as const;
    const tones = { provisional: 'brand', verifying: 'brand', ready: 'success', not_ready: 'warning' } as const;
    return { tone: tones[op.readiness.state], word: words[op.readiness.state] };
  }
  if (op.state === 'rechecking') return { tone: 'brand', word: 'Re-checking' };
  if (op.state === 'running') return { tone: 'brand', word: 'Running' };
  if (op.state === 'enrolling') return { tone: 'brand', word: 'Enrolling' };
  const stopped = stoppedState(op.state);
  return { tone: stopped.tone, word: stopped.title };
}
