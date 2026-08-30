import { promises as fs } from 'fs';
import path from 'path';

/**
 * Credential handoff for authenticated HTTPS clones.
 *
 * The token must never appear in argv, in the repository URL, or in any
 * generated subprocess metadata. Git's credential-helper protocol is the
 * sanctioned side channel: git invokes the helper with request attributes on
 * stdin and reads key=value lines from stdout. We write a tiny per-fetch
 * helper script that echoes the password straight from an environment
 * variable, and pass the actual token only through the child process env.
 *
 * The helper lives under the fetch workspace's `.meta/` directory, which the
 * caller deletes in its `finally` block together with the rest of the
 * workspace.
 *
 * Locating the helper: its path travels in the child environment, never in
 * the config value. Git treats `credential.helper` as a SHELL string, not as
 * argv: run-command's shell detection routes the value through `sh -c` as
 * soon as it contains any of `|&;<>()$\`\\"' \t\n*?[#~=%`, and a space is in
 * that set. Interpolating the path directly therefore word-splits whenever
 * the workspace sits under a directory with a space in its name (a plain
 * `/tmp/some dir` or a Windows `C:/Users/Ada Lovelace/AppData/Local/Temp`),
 * and git ends up executing the first path segment. Quoting the interpolated
 * path fixes that one case but keeps the path inside a shell string, one
 * unusual character away from breaking again. Pointing the shell at an
 * environment variable instead makes the config value a CONSTANT, so no
 * workspace path can affect how it parses.
 */

export const GIT_TOKEN_ENV_VAR = 'SENCHO_GIT_TOKEN';
export const GIT_HELPER_PATH_ENV_VAR = 'SENCHO_GIT_HELPER';
/** Lowercase host[:port] from the configured repository URL; credentials are refused elsewhere. */
export const GIT_ALLOWED_HOST_ENV_VAR = 'SENCHO_GIT_ALLOWED_HOST';
export const GIT_HELPER_USERNAME = 'x-access-token';

/**
 * The `credential.helper` value. The leading `!` tells git to run the rest as
 * a shell command (gitcredentials(7)); the quoted variable expands inside
 * that shell to the path we exported, whatever characters it holds.
 */
export const CREDENTIAL_HELPER_CONFIG_VALUE = `!"$${GIT_HELPER_PATH_ENV_VAR}"`;

/**
 * One POSIX script on every platform. Because the value above always routes
 * through a shell, the helper is always launched by git's own `sh` (Git for
 * Windows ships one and uses it for exactly this), so a `.cmd` variant would
 * add a second dialect without ever being reached more directly.
 */
const HELPER_SCRIPT = '#!/bin/sh\n'
    + 'allowed_host=""\n'
    + `if [ -n "$${GIT_ALLOWED_HOST_ENV_VAR}" ]; then allowed_host="$${GIT_ALLOWED_HOST_ENV_VAR}"; fi\n`
    + 'req_host=""\n'
    + 'req_port=""\n'
    + 'while IFS= read -r line; do\n'
    + '  [ -z "$line" ] && break\n'
    + '  case "$line" in\n'
    + '    host=*) req_host="${line#host=}" ;;\n'
    + '    port=*) req_port="${line#port=}" ;;\n'
    + '  esac\n'
    + 'done\n'
    + 'if [ -n "$req_port" ] && [ "$req_port" != "443" ]; then\n'
    + '  req_host="${req_host}:$req_port"\n'
    + 'fi\n'
    + 'if [ -n "$allowed_host" ] && [ "$req_host" != "$allowed_host" ]; then\n'
    + '  exit 0\n'
    + 'fi\n'
    + `printf 'username=${GIT_HELPER_USERNAME}\\n'\n`
    + `printf 'password=%s\\n' "$${GIT_TOKEN_ENV_VAR}"\n`;

/** Render the helper script body; exported for tests pinning the no-secret invariant. */
export function renderCredentialHelper(): string {
    return HELPER_SCRIPT;
}

/**
 * Write the helper executable into `metaDir` and return its absolute path
 * (forward slashes; git's shell accepts that spelling on Windows too). The
 * script contains only a variable REFERENCE, never the secret itself.
 */
export async function writeCredentialHelper(metaDir: string): Promise<string> {
    const helperPath = path.join(metaDir, 'credential-helper.sh');
    await fs.writeFile(helperPath, HELPER_SCRIPT, { mode: 0o700 });
    return helperPath.split(path.sep).join('/');
}
