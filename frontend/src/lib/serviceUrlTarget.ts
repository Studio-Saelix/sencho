/** The stack the URL dialog was opened for. Save must not follow a later navigation. */
export interface ServiceUrlDialogTarget {
  nodeId: number | null;
  stackName: string;
  serviceName: string;
}

export function sameServiceUrlTarget(
  opened: { nodeId: number | null; stackName: string },
  current: { nodeId: number | null; stackName: string | null },
): boolean {
  return current.stackName !== null
    && opened.nodeId === current.nodeId
    && opened.stackName === current.stackName;
}
