/**
 * The compose filenames Compose resolves on its own, in resolution order (the
 * first existing file wins). The order is neither alphabetical nor uniform
 * across the families: the compose.* family prefers .yaml over .yml, the legacy
 * docker-compose.* family prefers .yml over .yaml, and every override prefers
 * .yml. Verified against docker compose v5, which warns and names its pick
 * whenever a stack holds more than one candidate.
 *
 * Every caller that has to agree with what Compose loads, or with the `-f` list
 * a deploy pins when an extra layer forces explicit flags, resolves from these
 * two lists. A second copy of the order is a second selection rule, and a
 * recovery that pins the other competing file runs a project the deploy never
 * loaded while reporting success.
 */

/** Root compose files Compose discovers, in resolution order. */
export const COMPOSE_ROOT_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
] as const;

/** Implicit override files Compose merges on top, in resolution order. */
export const COMPOSE_OVERRIDE_FILENAMES = [
  'compose.override.yml',
  'compose.override.yaml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
] as const;
