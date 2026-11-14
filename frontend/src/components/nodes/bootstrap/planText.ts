import type { BootstrapPlan } from './types';

/**
 * Human-readable plan text for Copy plan and Download plan. The retained
 * artifact carries every step in execution order, every skipped stage, all
 * file contents, both paths and both digests.
 */
export function formatBootstrapPlanText(plan: BootstrapPlan): string {
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
