import path from 'path';
import { DOCKER_LOCAL_ENV } from './probes';
import { PILOT_CONTAINER_NAME, shellQuote } from './pathPolicy';

/**
 * The fixed commands execution adds around the plan's own steps: writing a
 * planned file, reading one back, and the read-only checks that establish what
 * a step actually did. Each is a constant script; every value it takes (paths,
 * modes, owners) is passed as a quoted positional argument, never spliced into
 * the script, and file content travels on standard input so it never appears
 * in a process argument.
 */

function withSudo(command: string, sudo: boolean): string {
  return sudo ? `sudo -n ${command}` : command;
}

/** Exit codes the write script uses for a refusal, so the executor can name it. */
export const WRITE_EXIT = {
  notDirectory: 20,
  exists: 17,
  notRegular: 21,
} as const;

const WRITE_SCRIPT = [
  'set -eu',
  'umask 077',
  'd=$1; n=$2; m=$3; o=$4; g=$5; nc=$6',
  `if [ ! -d "$d" ] || [ -L "$d" ]; then echo "not a directory: $d" >&2; exit ${WRITE_EXIT.notDirectory}; fi`,
  `if [ "$nc" = 1 ] && { [ -e "$d/$n" ] || [ -L "$d/$n" ]; }; then echo "already exists: $d/$n" >&2; exit ${WRITE_EXIT.exists}; fi`,
  `if [ -L "$d/$n" ] || { [ -e "$d/$n" ] && [ ! -f "$d/$n" ]; }; then echo "not a regular file: $d/$n" >&2; exit ${WRITE_EXIT.notRegular}; fi`,
  't=$(mktemp "$d/.$n.XXXXXX")',
  'trap \'rm -f "$t"\' EXIT',
  'cat > "$t"',
  'chown "$o:$g" "$t"',
  'chmod "$m" "$t"',
  'mv -fT "$t" "$d/$n"',
  'trap - EXIT',
].join('\n');

/**
 * Write standard input to `filePath` atomically: a temporary file in the same
 * directory gets the mode and owner first and is then renamed over the target.
 * With `noClobber` an existing entry fails the write instead of being replaced;
 * a symlink or non-regular entry is never written through.
 */
export function writeFileCommand(
  filePath: string,
  file: { mode: string; owner: string; group: string },
  options: { sudo: boolean; noClobber: boolean },
): string {
  const args = [
    path.posix.dirname(filePath),
    path.posix.basename(filePath),
    file.mode,
    file.owner,
    file.group,
    options.noClobber ? '1' : '0',
  ].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(WRITE_SCRIPT)} sencho-write ${args}`, options.sudo);
}

export const READ_EXIT = { missing: 3, notRegular: 4 } as const;

const READ_SCRIPT = [
  'set -eu',
  'p=$1',
  `if [ ! -e "$p" ] && [ ! -L "$p" ]; then exit ${READ_EXIT.missing}; fi`,
  `if [ -L "$p" ] || [ ! -f "$p" ]; then exit ${READ_EXIT.notRegular}; fi`,
  'base64 -w0 -- "$p"',
].join('\n');

/**
 * Print a regular file as base64, so its bytes survive output scrubbing; exit 3
 * when it does not exist, 4 when it is not a regular file.
 */
export function readFileCommand(filePath: string, sudo: boolean): string {
  return withSudo(`sh -c ${shellQuote(READ_SCRIPT)} sencho-read ${shellQuote(filePath)}`, sudo);
}

/** Octal mode, owner, group and type of one path, without following a final symlink. */
export function statCommand(target: string, sudo: boolean): string {
  return withSudo(`stat -c '%a %U %G %F' -- ${shellQuote(target)}`, sudo);
}

/** The daemon answers on the pinned local socket. */
export function dockerServerVersionCommand(sudo: boolean): string {
  return withSudo(`${DOCKER_LOCAL_ENV} docker version --format '{{.Server.Version}}'`, sudo);
}

/** The Compose v2 plugin answers through the Docker CLI. */
export function composeVersionCommand(sudo: boolean): string {
  return withSudo(`${DOCKER_LOCAL_ENV} docker compose version --short`, sudo);
}

/**
 * systemd's view of the Docker service: active state, then enablement. It runs
 * with the privilege the service step used: on a host without D-Bus, only root
 * reaches systemd through its private socket.
 */
export function dockerServiceStateCommand(sudo: boolean): string {
  return withSudo("sh -c 'systemctl is-active docker; systemctl is-enabled docker'", sudo);
}

/** State and Compose labels of the Pilot container, separated by `|`. */
export function agentContainerCommand(sudo: boolean): string {
  const format = '{{.State.Status}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}';
  return withSudo(`${DOCKER_LOCAL_ENV} docker inspect --type container --format ${shellQuote(format)} ${PILOT_CONTAINER_NAME}`, sudo);
}
