/**
 * Header the hub sets on a Fleet read response when one of its own reads was cut
 * at its deadline while the hub kept the build running. A tab that asked for
 * one node and sees it asks again, which joins that build.
 */
const FLEET_BUILD_KEPT_HEADER = 'x-sencho-build-kept';

/** Reads each node at most this many times per load: the read, then one retry that joins a kept build. */
export const FLEET_READ_ATTEMPTS = 2;

/** `headers` is optional because other suites hand the hooks bare `{ ok, json }` doubles; a real Response always has it. */
export function hubKeptBuild(res: Response): boolean {
  return res.headers?.get(FLEET_BUILD_KEPT_HEADER) === '1';
}
