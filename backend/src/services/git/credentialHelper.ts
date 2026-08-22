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
 */

export const GIT_TOKEN_ENV_VAR = 'SENCHO_GIT_TOKEN';
export const GIT_HELPER_USERNAME = 'x-access-token';

const POSIX_HELPER = '#!/bin/sh\n'
    + `printf 'username=${GIT_HELPER_USERNAME}\\n'\n`
    + `printf 'password=%s\\n' "$${GIT_TOKEN_ENV_VAR}"\n`;

const WINDOWS_HELPER = '@echo off\r\n'
    + 'setlocal enabledelayedexpansion\r\n'
    + `echo username=${GIT_HELPER_USERNAME}\r\n`
    + `echo password=!${GIT_TOKEN_ENV_VAR}!\r\n`;

/** Render the helper script body; exported for tests pinning the no-secret invariant. */
export function renderCredentialHelper(isWindows: boolean): string {
    return isWindows ? WINDOWS_HELPER : POSIX_HELPER;
}

/**
 * Write the helper executable into `metaDir` and return its absolute path
 * (forward slashes; git accepts both spellings on Windows). The script
 * contains only a variable REFERENCE, never the secret itself.
 */
export async function writeCredentialHelper(metaDir: string): Promise<string> {
    const isWindows = process.platform === 'win32';
    const fileName = isWindows ? 'credential-helper.cmd' : 'credential-helper.sh';
    const helperPath = path.join(metaDir, fileName);
    await fs.writeFile(helperPath, renderCredentialHelper(isWindows), { mode: 0o700 });
    return helperPath.split(path.sep).join('/');
}
