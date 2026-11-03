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
  constructor(readonly volumeName: string) {
    super(
      `This container uses the volume "${volumeName}", which a data restore is overwriting. `
      + 'Sencho will not start it until that restore has been resolved.',
    );
    this.name = 'DataRestoreFenceError';
  }
}

export function isDataRestoreFenceError(error: unknown): error is DataRestoreFenceError {
  return error instanceof DataRestoreFenceError;
}
