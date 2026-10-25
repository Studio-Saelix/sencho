/**
 * Shown on the env tab when the inventory or a file's content could not be
 * read. Unknown is distinct from "no env file": the editor must not offer to
 * create over it, and the empty buffer must not read as an empty file.
 */
export const ENV_READ_FAILED_NOTICE =
  "This stack's environment files could not be loaded. Reload the editor before saving, so an existing file is not overwritten.";
