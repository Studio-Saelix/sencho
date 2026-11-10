import path from 'path';
import { DOCKER_LOCAL_ENV } from './probes';
import { PILOT_CONTAINER_NAME, shellQuote } from './pathPolicy';

/**
 * The fixed commands execution adds around the plan's own steps: writing a
 * planned file, reading one back, and the read-only checks that establish what
 * a step actually did. The write and read scripts are constants that take
 * every value (paths, modes, owners, the content hash) as a quoted positional
 * argument; the other checks are constants with at most one `shellQuote`d path.
 * File content travels on standard input, so it never appears in a process
 * argument.
 */

function withSudo(command: string, sudo: boolean): string {
  return sudo ? `sudo -n ${command}` : command;
}

/** Exit codes the write and directory scripts use for a refusal, so the executor can name it. */
export const WRITE_EXIT = {
  notDirectory: 20,
  exists: 17,
  notRegular: 21,
  incomplete: 22,
  /** The destination could not be published for a reason other than something already being there. */
  notPublished: 23,
} as const;

/**
 * Enter a directory without trusting its name twice. The name is inspected
 * without following a final symlink (it must be a directory), the shell
 * changes into it, and the directory it is in must be the one inspected: a name
 * swapped for a symlink or another directory in between refuses here, before
 * anything is changed. Every later operation uses names relative to the
 * directory the shell holds, so a swap after this point cannot redirect it.
 */
const ENTER_DIRECTORY = [
  'enter() {',
  '  before=$(stat -c "%F:%d:%i" -- "$1" 2>/dev/null) || before=',
  '  case $before in directory:*) ;; *) return 1 ;; esac',
  '  cd -P -- "$1" 2>/dev/null || return 1',
  '  [ "$(stat -c "%F:%d:%i" -- . 2>/dev/null)" = "$before" ]',
  '}',
].join('\n');

const WRITE_SCRIPT = [
  'set -eu',
  'umask 077',
  'd=$1; n=$2; m=$3; o=$4; g=$5; ph=$6; h=$7',
  ENTER_DIRECTORY,
  `enter "$d" || { echo "not a directory, or it changed: $d" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
  // A name that already holds something is refused here without waiting for the
  // content to arrive; the publication below is what makes the refusal hold.
  `if [ -z "$ph" ] && { [ -e "./$n" ] || [ -L "./$n" ]; }; then echo "already exists: $d/$n" >&2; exit ${WRITE_EXIT.exists}; fi`,
  `if [ -L "./$n" ] || { [ -e "./$n" ] && [ ! -f "./$n" ]; }; then echo "not a regular file: $d/$n" >&2; exit ${WRITE_EXIT.notRegular}; fi`,
  't=$(mktemp "./.$n.XXXXXX")',
  'old=',
  // A dropped session ends the shell through a signal, which skips the exit
  // trap unless the signal is turned into an exit: the temporary file holds
  // the enrollment token.
  'trap \'rm -f "$t"\' EXIT',
  'trap \'exit 1\' HUP INT TERM',
  'cat > "$t"',
  // Standard input ends early when the session drops; the hash keeps a short
  // file from being published.
  `if [ "$(sha256sum "$t" | cut -d' ' -f1)" != "$h" ]; then echo "content incomplete: $d/$n" >&2; exit ${WRITE_EXIT.incomplete}; fi`,
  'chown "$o:$g" "$t"',
  'chmod "$m" "$t"',
  // Replacing an inspected file moves whatever is at the name aside in one
  // atomic rename, then checks that it is the file that was inspected. Anything
  // else is put back and the write refuses, so no other file is ever replaced.
  'if [ -n "$ph" ]; then',
  '  old=$(mktemp "./.$n.old.XXXXXX")',
  '  if mv -fT -- "./$n" "$old" 2>/dev/null; then',
  '    if [ -L "$old" ] || [ ! -f "$old" ] || [ "$(sha256sum "$old" | cut -d\' \' -f1)" != "$ph" ]; then',
  // The hard link puts it back only when the name is still free; a rename is the
  // fallback for what cannot be linked (a directory) and counts only when the
  // moved-aside name is gone afterwards. Otherwise the file stays where it is.
  '      if ln -T -- "$old" "./$n" 2>/dev/null; then',
  '        rm -f "$old"; old=',
  '        echo "changed since it was inspected: $d/$n" >&2',
  '      elif mv -nT -- "$old" "./$n" 2>/dev/null && [ ! -e "$old" ] && [ ! -L "$old" ]; then',
  '        old=',
  '        echo "changed since it was inspected: $d/$n" >&2',
  '      else',
  '        echo "changed since it was inspected: $d/$n; the file that was there is kept as $d/${old#./}" >&2',
  '        old=',
  '      fi',
  `      exit ${WRITE_EXIT.exists}`,
  '    fi',
  '  else',
  '    rm -f "$old"; old=',
  '  fi',
  'fi',
  // A hard link publishes only when the name is free, atomically; unlike a
  // rename it cannot replace a file another process created after the check.
  'if ! ln -T -- "$t" "./$n" 2>/dev/null; then',
  '  if [ -e "./$n" ] || [ -L "./$n" ]; then',
  '    rm -f "$old"',
  `    echo "already exists: $d/$n" >&2; exit ${WRITE_EXIT.exists}`,
  '  fi',
  '  if [ -n "$old" ]; then mv -nT -- "$old" "./$n" 2>/dev/null || true; old=; fi',
  `  echo "could not publish: $d/$n" >&2; exit ${WRITE_EXIT.notPublished}`,
  'fi',
  'rm -f "$old"',
].join('\n');

/**
 * Write standard input to `filePath`: a temporary file in the same directory
 * must hash to `sha256`, then gets the mode and owner and is published by a
 * hard link, which refuses a name that already holds anything (a file, a
 * symlink or a directory), even one created after the content arrived. With
 * `replaces` (the sha256 of the file the executor inspected) the entry at the
 * name is first moved aside and must be that file; anything else is put back
 * and the write is refused. The directory is entered once and every name is
 * relative to it, so a symlink swapped in for the directory or one of its
 * ancestors after the check is refused instead of followed.
 */
export function writeFileCommand(
  filePath: string,
  file: { mode: string; owner: string; group: string; sha256: string },
  options: { sudo: boolean; replaces: string | null },
): string {
  const args = [
    path.posix.dirname(filePath),
    path.posix.basename(filePath),
    file.mode,
    file.owner,
    file.group,
    options.replaces ?? '',
    file.sha256,
  ].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(WRITE_SCRIPT)} sencho-write ${args}`, options.sudo);
}

const DIRECTORY_SCRIPT = [
  'set -eu',
  'umask 077',
  'p=$1; m=$2; o=$3; g=$4; keep=$5',
  ENTER_DIRECTORY,
  'parent=$(dirname -- "$p"); name=$(basename -- "$p")',
  `enter "$parent" || { echo "not a directory, or it changed: $parent" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
  // mkdir never follows or replaces an existing name, a symlink included, so
  // a name taken since the plan was approved is refused, not changed.
  'if ! mkdir -- "./$name" 2>/dev/null; then',
  '  if [ "$keep" != 1 ] || [ -L "./$name" ] || [ ! -d "./$name" ]; then',
  `    echo "already exists: $p" >&2; exit ${WRITE_EXIT.exists}`,
  '  fi',
  'fi',
  'enter "./$name" || { echo "changed while it was set up: $p" >&2; exit 1; }',
  'chown "$o:$g" .',
  'chmod "$m" .',
].join('\n');

/**
 * Create the directory `dirPath` (its parent must exist) with the mode and
 * owner, changing only the directory it created. A name that exists is
 * refused, a symlink never followed; `allowExisting` accepts an existing real
 * directory (the apt keyring directory) and applies the mode and owner to
 * that directory itself, never through a symlink.
 */
export function createDirectoryCommand(
  dirPath: string,
  dir: { mode: string; owner: string; group: string },
  options: { sudo: boolean; allowExisting: boolean },
): string {
  const args = [dirPath, dir.mode, dir.owner, dir.group, options.allowExisting ? '1' : '0'].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(DIRECTORY_SCRIPT)} sencho-mkdir ${args}`, options.sudo);
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
 * when it does not exist, 4 when it is not a regular file. Its output is file
 * content: the executor never records it in a failure detail.
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
