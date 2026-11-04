/**
 * The refusal a container start or restart gets while a volume it mounts is
 * fenced by a staged overwrite.
 *
 * It lives in its own module so the Docker controller, the Files & Volumes
 * browser and the routes can all name it without importing the recovery engine
 * (which imports the controller).
 */
export const DATA_RESTORE_FENCE_CODE = 'data_restore';

export class DataRestoreFenceError extends Error {
  readonly code = DATA_RESTORE_FENCE_CODE;
  /**
   * `container` for a container start or restart; `browse` for the Files &
   * Volumes browser, which opens the volume and starts no container of the
   * operator's, so it must not say a container will not start.
   */
  constructor(readonly volumeName: string, subject: 'container' | 'browse' = 'container') {
    super(
      subject === 'browse'
        ? `The volume "${volumeName}" is being overwritten by a data restore. `
          + 'Sencho will not open it until that restore has been resolved.'
        : `This container uses the volume "${volumeName}", which a data restore is overwriting. `
          + 'Sencho will not start it until that restore has been resolved.',
    );
    this.name = 'DataRestoreFenceError';
  }
}

export function isDataRestoreFenceError(error: unknown): error is DataRestoreFenceError {
  return error instanceof DataRestoreFenceError;
}
