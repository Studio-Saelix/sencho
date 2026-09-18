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
    return marker;
  } catch {
    return null;
  }
}
