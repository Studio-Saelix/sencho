/**
 * Header the hub sets on a per-node Fleet read it cut at its own deadline while
 * it kept the build running. Asking again joins that build.
 */
const FLEET_BUILD_KEPT_HEADER = 'x-sencho-build-kept';

/** Reads each node at most this many times per load: the read, then one retry that joins a kept build. */
export const FLEET_READ_ATTEMPTS = 2;

export function hubKeptBuild(res: Response): boolean {
  return res.headers?.get(FLEET_BUILD_KEPT_HEADER) === '1';
}
