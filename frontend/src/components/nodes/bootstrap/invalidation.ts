import type { BootstrapForm, BootstrapInvalidation } from './types';

// A later, smaller edit must not hide a host change: the SSH target outranks
// everything, and the order of the other three follows how much they discard.
const RANK: Record<BootstrapInvalidation, number> = { name: 0, paths: 1, key: 2, target: 3 };

export function invalidationForField(field: keyof BootstrapForm): BootstrapInvalidation {
  switch (field) {
    case 'host':
    case 'port':
    case 'username':
      return 'target';
    case 'privateKey':
    case 'passphrase':
      return 'key';
    case 'composeDir':
    case 'agentDir':
      return 'paths';
    case 'targetName':
      return 'name';
  }
}

// Every reason raised since the last result is kept, so clearing the SSH target
// reason after a host key check lets a key, paths or name reason still show.
export function strongestInvalidation(reasons: readonly BootstrapInvalidation[]): BootstrapInvalidation | null {
  let strongest: BootstrapInvalidation | null = null;
  for (const reason of reasons) {
    if (strongest === null || RANK[reason] > RANK[strongest]) strongest = reason;
  }
  return strongest;
}

// Keep in step with the banner table in docs/features/node-bootstrap.mdx.
export const INVALIDATION_MESSAGE: Record<BootstrapInvalidation, string> = {
  target: 'The SSH target changed. The previous host key check, preflight and plan no longer apply. Check the host key again.',
  key: 'The SSH key changed. The previous preflight and plan no longer apply. Run the preflight again.',
  paths: 'Paths changed. The previous preflight and plan no longer apply. Run the preflight again.',
  name: 'The node name changed. The previous preflight and plan no longer apply. Run the preflight again.',
};
