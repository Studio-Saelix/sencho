import type { DriftFindingKind } from '@/types/drift';

export const DRIFT_FINDING_LABEL: Record<DriftFindingKind, string> = {
  'service-missing': 'service missing',
  'service-undeclared': 'undeclared',
  'image-mismatch': 'image',
  'ports-mismatch': 'ports',
  'network-undeclared': 'network',
  'network-missing': 'network missing',
  'managed-path-conflict': 'managed path',
};
