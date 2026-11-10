import type { StatusPathAnswer, StatusPathStage } from '@/components/ui/status-path';
import type { StatusTone } from '@/lib/statusTone';
import type { BootstrapOperation, BootstrapOperationDetail, BootstrapOperationState } from './types';

/**
 * Maps a bootstrap operation onto the Answer and Path of `StatusPath`.
 *
 * The Answer is the operation's state in one sentence. The Path groups the
 * plan's stages into the phases an operator recognizes (recheck, Docker, Pilot
 * files, start, enrollment); a phase the plan does not contain is omitted.
 */

const RUNNING_STATES: readonly BootstrapOperationState[] = ['rechecking', 'running', 'enrolling'];

export function isOperationRunning(op: Pick<BootstrapOperation, 'state'>): boolean {
  return RUNNING_STATES.includes(op.state);
}

type Phase = 'recheck' | 'docker' | 'files' | 'start' | 'enroll';

const PHASE_LABEL: Record<Phase, string> = {
  recheck: 'recheck',
  docker: 'docker',
  files: 'pilot files',
  start: 'start',
  enroll: 'enroll',
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

const ORDER: Phase[] = ['recheck', 'docker', 'files', 'start', 'enroll'];

function phasesIn(op: BootstrapOperationDetail): Phase[] {
  const present = new Set<Phase>(['recheck', 'enroll']);
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
  const stopped = STOPPED[op.state];
  if (op.state === 'enrolled') {
    return {
      tone: stopped.tone,
      title: stopped.title,
      status: op.state,
      line: `${op.targetName} is enrolled. Its readiness for deployments has not been verified yet.`,
    };
  }
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

export function operationStages(op: BootstrapOperationDetail): StatusPathStage[] {
  const phases = phasesIn(op);
  const reached = phases.indexOf(currentPhase(op));
  const running = isOperationRunning(op);
  const stopped = running ? null : STOPPED[op.state as keyof typeof STOPPED];
  return phases.map((phase, index): StatusPathStage => {
    const base = { id: phase, label: PHASE_LABEL[phase], 'data-testid': `bootstrap-phase-${phase}` };
    if (op.state === 'enrolled') return { ...base, tone: 'success', word: phase === 'enroll' ? 'connected' : 'done', status: 'done' };
    if (index < reached) return { ...base, tone: 'success', word: 'done', status: 'done' };
    if (index === reached) {
      if (running) return { ...base, tone: 'brand', word: phase === 'enroll' ? 'waiting' : 'running', status: 'running' };
      return { ...base, tone: stopped?.tone ?? 'neutral', word: stopped?.word ?? 'stopped', status: op.state };
    }
    return { ...base, tone: 'neutral', word: running ? 'pending' : 'not run', status: 'pending' };
  });
}

/** The state word for a compact row in the operations list. */
export function operationStateWord(op: Pick<BootstrapOperation, 'state'>): { tone: StatusTone; word: string } {
  if (op.state === 'rechecking') return { tone: 'brand', word: 'Re-checking' };
  if (op.state === 'running') return { tone: 'brand', word: 'Running' };
  if (op.state === 'enrolling') return { tone: 'brand', word: 'Enrolling' };
  const stopped = STOPPED[op.state];
  return { tone: stopped.tone, word: stopped.title };
}
