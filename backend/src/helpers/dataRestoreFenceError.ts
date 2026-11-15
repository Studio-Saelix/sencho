/**
 * The refusal a container start or restart, or the Files & Volumes browser, gets
 * while the volume it mounts or opens is fenced by a staged overwrite.
 *
 * It lives in its own module so the Docker controller, the Files & Volumes
 * browser and the routes can all name it without importing the recovery engine
 * (which imports the controller).
 */
export const DATA_RESTORE_FENCE_CODE = 'data_restore';

/** Who was refused, which decides the wording: a container is started, a volume is opened. */
export type FenceSubject = 'container' | 'browse';

/** What the restore is overwriting: a named volume, or a host directory a stack binds. */
export type FencedTargetKind = 'volume' | 'directory';

export class DataRestoreFenceError extends Error {
  readonly code = DATA_RESTORE_FENCE_CODE;
  /**
   * `browse` is the Files & Volumes browser, which opens the volume and starts no
   * container of the operator's, so it must not say a container will not start.
   */
  constructor(
    readonly volumeName: string,
    subject: FenceSubject = 'container',
    target: FencedTargetKind = 'volume',
    /** The start was refused because a directory was fenced while it was being checked, not because it mounts that one. */
    unchecked = false,
  ) {
    const noun = target === 'directory' ? 'directory' : 'volume';
    super(
      unchecked
        ? 'A data restore started overwriting a directory while Sencho was checking what this container mounts. '
          + 'Try again: the start is checked against that restore first.'
        : subject === 'browse'
        ? target === 'directory'
          ? `This location overlaps the directory "${volumeName}", which a data restore is overwriting. `
            + 'Sencho will not open it until that restore has been resolved.'
          : `The volume "${volumeName}" is being overwritten by a data restore. `
            + 'Sencho will not open it until that restore has been resolved.'
        : `This container uses the ${noun} "${volumeName}", which a data restore is overwriting. `
          + 'Sencho will not start it until that restore has been resolved.',
    );
    this.name = 'DataRestoreFenceError';
  }
}

export function isDataRestoreFenceError(error: unknown): error is DataRestoreFenceError {
  return error instanceof DataRestoreFenceError;
}
