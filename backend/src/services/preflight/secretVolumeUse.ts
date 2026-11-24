import { isReservedSecretVolumeName } from '../../helpers/secretVolume';
import type { EffectiveModel } from './effectiveModel';

/**
 * Whether a rendered Compose model reaches a volume that holds a secret Sencho
 * keeps on this node. One pure evaluator, shared by the deploy guard in
 * `ComposeService`, the labels dry-run preview and the Compose Doctor rule
 * `secret-volume-reference`, so a preview or a report never disagrees with
 * what a deploy refuses.
 *
 * The first two conditions need no node state: a stack that declares the
 * reserved name or the reserved label is refused even before the first secret
 * reaches the node, so no stack can create and mount a look-alike volume first.
 */

/** Stack kinds Sencho records for the stack that consumes a secret volume. */
export const SECRET_VOLUME_EXEMPT_KINDS: ReadonlySet<string> = new Set(['edge-tunnel', 'released-edge-tunnel']);

/** True when a stack's managed kind lets it reference a secret volume. */
export function isSecretVolumeExemptKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && SECRET_VOLUME_EXEMPT_KINDS.has(kind);
}

/** A container on the node that mounts a secret volume. */
export interface SecretConsumerContainer {
  id: string;
  /** Container names without the leading slash. */
  names: string[];
}

/** What the evaluator needs to know about the node. */
export interface SecretVolumeNodeFacts {
  /** Volumes on the node that carry the secret volume label. */
  labelledVolumeNames: ReadonlySet<string>;
  /**
   * Containers that mount a secret volume, or null when they were not read
   * (the model names no `container:` reference, or node state is unavailable).
   */
  consumers: readonly SecretConsumerContainer[] | null;
}

export type SecretVolumeUseFinding =
  | { kind: 'reserved-name' | 'declared-label' | 'labelled-volume'; volumeKey: string; volumeName: string }
  | { kind: 'volumes-from' | 'pid'; service: string; container: string };

/** True when any service names a container with `volumes_from` or `pid`, so consumers must be read. */
export function modelReferencesContainers(model: EffectiveModel): boolean {
  return model.services.some((svc) => (svc.volumesFromContainers?.length ?? 0) > 0 || svc.pidContainer !== undefined);
}

function matchesConsumer(rawRef: string, consumer: SecretConsumerContainer): boolean {
  // The daemon resolves `/name` and `name` to the same container.
  const ref = rawRef.replace(/^\/+/, '');
  if (ref === '') return false;
  if (consumer.names.includes(ref)) return true;
  // Docker accepts a unique id prefix as a container reference.
  return /^[0-9a-f]+$/i.test(ref) && consumer.id.toLowerCase().startsWith(ref.toLowerCase());
}

/** Every way the model reaches a secret volume. Empty when it reaches none. */
export function evaluateSecretVolumeUse(model: EffectiveModel, facts: SecretVolumeNodeFacts): SecretVolumeUseFinding[] {
  const findings: SecretVolumeUseFinding[] = [];
  for (const [volumeKey, volume] of Object.entries(model.volumes)) {
    if (isReservedSecretVolumeName(volume.name)) {
      findings.push({ kind: 'reserved-name', volumeKey, volumeName: volume.name });
    } else if (volume.hasSecretLabel === true) {
      findings.push({ kind: 'declared-label', volumeKey, volumeName: volume.name });
    } else if (facts.labelledVolumeNames.has(volume.name)) {
      findings.push({ kind: 'labelled-volume', volumeKey, volumeName: volume.name });
    }
  }
  if (facts.consumers && facts.consumers.length > 0) {
    const consumers = facts.consumers;
    const isConsumer = (ref: string) => consumers.some((consumer) => matchesConsumer(ref, consumer));
    for (const svc of model.services) {
      for (const ref of svc.volumesFromContainers ?? []) {
        if (isConsumer(ref)) findings.push({ kind: 'volumes-from', service: svc.name, container: ref });
      }
      if (svc.pidContainer !== undefined && isConsumer(svc.pidContainer)) {
        findings.push({ kind: 'pid', service: svc.name, container: svc.pidContainer });
      }
    }
  }
  return findings;
}

/** One sentence per finding, naming the volume or the reference. */
export function describeSecretVolumeUse(finding: SecretVolumeUseFinding): string {
  switch (finding.kind) {
    case 'reserved-name':
      return `The volume "${finding.volumeName}" uses a name Sencho reserves for a secret it keeps on this node.`;
    case 'declared-label':
      return `The volume "${finding.volumeName}" declares the label io.sencho.secret, which Sencho reserves.`;
    case 'labelled-volume':
      return `The volume "${finding.volumeName}" holds a secret Sencho keeps on this node.`;
    case 'volumes-from':
      return `Service "${finding.service}" takes the volumes of container "${finding.container}", which mounts a secret Sencho keeps on this node.`;
    case 'pid':
      return `Service "${finding.service}" joins the process namespace of container "${finding.container}", which mounts a secret Sencho keeps on this node.`;
  }
}

/** What the operator can change so the stack no longer reaches the secret. */
export const SECRET_VOLUME_REMEDY = 'Rename the volume, remove the io.sencho.secret label, or remove the reference to that container, then try again.';

/** The deploy refusal for a model that reaches a secret volume. */
export function secretVolumeUseRefusalMessage(stackName: string, findings: readonly SecretVolumeUseFinding[]): string {
  return `Sencho refused to run "${stackName}" because it would reach a secret volume. `
    + `${findings.map(describeSecretVolumeUse).join(' ')} ${SECRET_VOLUME_REMEDY}`;
}

/** The deploy refusal when the check could not run. */
export function secretVolumeUnverifiedMessage(stackName: string, why: string): string {
  return `Sencho could not verify that "${stackName}" does not reach a secret volume on this node (${why}), so it was not run. `
    + 'Fix the Compose configuration or check the Docker connection, then try again.';
}
