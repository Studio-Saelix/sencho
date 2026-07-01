export type LabelSource = 'compose' | 'runtime' | 'image' | 'compose-system' | 'unknown';

export interface LabelValue {
  key: string;
  value: string;
  source: LabelSource;
  redacted?: boolean;
}

export interface ContainerLabelRow {
  id: string;
  name: string;
  stack: string | null;
  service: string | null;
  state: string;
  labels: LabelValue[];
}

export interface LabelIndexContainerRef {
  id: string;
  name: string;
  stack: string | null;
  service: string | null;
  nodeId?: number;
  nodeName?: string;
}

export interface LabelIndexRow {
  key: string;
  value: string;
  redacted?: boolean;
  source: LabelSource;
  containers: LabelIndexContainerRef[];
}

export interface FleetLabelInventoryResponse {
  nodes: Array<{
    nodeId: number;
    nodeName: string;
    status: 'ok' | 'error';
    inventory: {
      nodeId: number;
      containers: ContainerLabelRow[];
      byLabel: LabelIndexRow[];
      partial: boolean;
      generatedAt: number;
    } | null;
    error: string | null;
  }>;
  aggregatedByLabel: LabelIndexRow[];
  nodeErrors: Record<number, string>;
  generatedAt: number;
}

export interface StackLabelReplica {
  id: string;
  name: string;
  state: string;
  runtimeLabels: LabelValue[];
  onlyInCompose: string[];
  onlyOnContainer: string[];
  inBoth: string[];
  // Optional so older nodes (pre-provenance) still typecheck during mixed-version operation.
  changed?: string[];
  inspectFailed?: boolean;
}

export interface StackServiceLabelRow {
  service: string;
  declaredLabels: LabelValue[];
  replicas: StackLabelReplica[];
}

export interface StackLabelInventory {
  stackName: string;
  renderable: boolean;
  services: StackServiceLabelRow[];
  // Optional so older nodes still typecheck during mixed-version operation.
  partial?: boolean;
  generatedAt: number;
}

export const LABEL_DISAMBIGUATION_COPY =
  'Docker labels are metadata declared on Compose services or attached to running containers. They are different from Sencho Stack Labels used for organizing stacks and Node Labels used for Blueprint placement.';

export const SOURCE_LABELS: Record<LabelSource, string> = {
  compose: 'Declared in Compose',
  runtime: 'Present at runtime',
  image: 'Image',
  'compose-system': 'Docker Compose system label',
  unknown: 'Unknown',
};
