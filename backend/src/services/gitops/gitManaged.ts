import type { Blueprint } from '../DatabaseService';

export class GitManagedContentError extends Error {
  readonly code = 'git_managed_content';
  constructor(message = 'Blueprint content is Git-managed and cannot be edited inline') {
    super(message);
    this.name = 'GitManagedContentError';
  }
}

export function isGitManagedBlueprint(blueprint: Pick<Blueprint, 'content_origin'>): boolean {
  return blueprint.content_origin === 'git';
}

export function throwIfGitManagedDeploy(blueprint: Pick<Blueprint, 'content_origin'> | undefined): void {
  if (blueprint && isGitManagedBlueprint(blueprint)) {
    throw new GitManagedContentError('Blueprint content is Git-managed and cannot be deployed inline');
  }
}
