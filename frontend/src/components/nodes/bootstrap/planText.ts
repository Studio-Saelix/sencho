import type { BootstrapPlan } from './types';

/** Human-readable plan text for Copy plan and Download plan. */
export function formatBootstrapPlanText(plan: BootstrapPlan): string {
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
