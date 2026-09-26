/**
 * Dependency-neutral blueprint marker parse helpers.
 * Used by BlueprintService and DeployedStackDeletionService without a service import cycle.
 */

export const BLUEPRINT_MARKER_FILENAME = '.blueprint.json';

export interface BlueprintMarker {
  blueprintId: number;
  revision: number;
  lastApplied: number;
  applicationId?: string;
  bindingRevision?: string;
  /**
   * The GitOps generation whose materialization was deployed to this node.
   *
   * This is the only on-node evidence of which generation is actually running.
   * Without it a drift repair cannot prove what it is about to overwrite, so a
   * repair treats its absence as incomplete evidence rather than assuming the
   * target still runs what it acknowledged.
   */
  generationId?: string;
  /** The rollout generation that authorized this deployment, when there was one. */
  rolloutGenerationId?: string;
  /** The artifact set the deployed generation was qualified under. */
  artifactSetId?: string;
}

export function buildBlueprintMarker(input: {
  blueprintId: number;
  revision: number;
  lastApplied: number;
  applicationId?: string;
  bindingRevision?: string;
  generationId?: string;
  rolloutGenerationId?: string;
  artifactSetId?: string;
}): BlueprintMarker {
  const marker: BlueprintMarker = {
    blueprintId: input.blueprintId,
    revision: input.revision,
    lastApplied: input.lastApplied,
  };
  if (input.applicationId !== undefined) marker.applicationId = input.applicationId;
  if (input.bindingRevision !== undefined) marker.bindingRevision = input.bindingRevision;
  if (input.generationId !== undefined) marker.generationId = input.generationId;
  if (input.rolloutGenerationId !== undefined) marker.rolloutGenerationId = input.rolloutGenerationId;
  if (input.artifactSetId !== undefined) marker.artifactSetId = input.artifactSetId;
  return marker;
}

export function parseBlueprintMarker(content: string): BlueprintMarker | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.blueprintId !== 'number' || typeof obj.revision !== 'number') return null;
    const marker: BlueprintMarker = {
      blueprintId: obj.blueprintId,
      revision: obj.revision,
      lastApplied: typeof obj.lastApplied === 'number' ? obj.lastApplied : 0,
    };
    if (typeof obj.applicationId === 'string') marker.applicationId = obj.applicationId;
    if (typeof obj.bindingRevision === 'string') marker.bindingRevision = obj.bindingRevision;
    // Absent generation fields are tolerated so markers written before the
    // fields existed still parse. A repair reads their absence as incomplete
    // evidence rather than as a match.
    if (typeof obj.generationId === 'string') marker.generationId = obj.generationId;
    if (typeof obj.rolloutGenerationId === 'string') marker.rolloutGenerationId = obj.rolloutGenerationId;
    if (typeof obj.artifactSetId === 'string') marker.artifactSetId = obj.artifactSetId;
    return marker;
  } catch {
    return null;
  }
}
