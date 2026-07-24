/**
 * Dependency-neutral blueprint marker parse helpers.
 * Used by BlueprintService and DeployedStackDeletionService without a service import cycle.
 */

export const BLUEPRINT_MARKER_FILENAME = '.blueprint.json';

export interface BlueprintMarker {
  blueprintId: number;
  revision: number;
  lastApplied: number;
}

export function parseBlueprintMarker(content: string): BlueprintMarker | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.blueprintId !== 'number' || typeof obj.revision !== 'number') return null;
    return {
      blueprintId: obj.blueprintId,
      revision: obj.revision,
      lastApplied: typeof obj.lastApplied === 'number' ? obj.lastApplied : 0,
    };
  } catch {
    return null;
  }
}
