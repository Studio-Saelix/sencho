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

/**
 * Exit codes the write and directory scripts use. The executor names 20, 17,
 * 21, 22, 24 and 25; 23 (and any other non-zero) is a plain step failure with
 * the script's own error text.
 */
export const WRITE_EXIT = {
  notDirectory: 20,
  exists: 17,
  notRegular: 21,
  incomplete: 22,
  /** The destination could not be published for a reason other than something already being there. */
  notPublished: 23,
  /** The directory could not be created, and nothing was. */
  notCreated: 24,
  /** A directory was created, but could not be finished (its owner or mode, or it was swapped meanwhile). */
  unfinished: 25,
} as const;

/**
 * Enter a directory without trusting its name twice, and only if it is the
 * directory that was approved. The name is inspected without following a final
 * symlink (it must be a directory), the shell changes into it, the directory it
 * is in must be the one inspected, and its physical path (`pwd -P`) must be the
 * one the plan approved ($2): a name or an ancestor swapped for a symlink or
 * another directory, before this script started or in between, refuses here,
 * before anything is changed. Every later operation uses names relative to the
 * directory the shell holds, so a swap after this point cannot redirect it.
 */
const ENTER_DIRECTORY = [
  'enter() {',
  '  before=$(stat -c "%F:%d:%i" -- "$1" 2>/dev/null) || before=',
  '  case $before in directory:*) ;; *) return 1 ;; esac',
  '  cd -P -- "$1" 2>/dev/null || return 1',
  '  [ "$(stat -c "%F:%d:%i" -- . 2>/dev/null)" = "$before" ] || return 1',
  '  [ "$(pwd -P)" = "$2" ]',
  '}',
].join('\n');

/** The same pinning for a name whose own symlink is fine: an ancestor of a new directory may be one, and the plan shows where it leads. */
const ENTER_VIA_LINKS = [
  'enter_via() {',
  '  before=$(stat -L -c "%F:%d:%i" -- "$1" 2>/dev/null) || before=',
  '  case $before in directory:*) ;; *) return 1 ;; esac',
  '  cd -P -- "$1" 2>/dev/null || return 1',
  '  [ "$(stat -c "%F:%d:%i" -- . 2>/dev/null)" = "$before" ] || return 1',
  '  [ "$(pwd -P)" = "$2" ]',
  '}',
].join('\n');

const WRITE_SCRIPT = [
  'set -eu',
  'umask 077',
  'd=$1; n=$2; m=$3; o=$4; g=$5; ph=$6; h=$7; e=$8',
  ENTER_DIRECTORY,
  `enter "$d" "$e" || { echo "not the approved directory, or it changed: $d" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
  // A name that already holds something is refused here without waiting for the
  // content to arrive; the publication below is what makes the refusal hold.
  `if [ -z "$ph" ] && { [ -e "./$n" ] || [ -L "./$n" ]; }; then echo "already exists: $d/$n" >&2; exit ${WRITE_EXIT.exists}; fi`,
  `if [ -L "./$n" ] || { [ -e "./$n" ] && [ ! -f "./$n" ]; }; then echo "not a regular file: $d/$n" >&2; exit ${WRITE_EXIT.notRegular}; fi`,
  't=$(mktemp "./.$n.XXXXXX")',
  'slot=; slot_id=; old=; moving=0; published=0',
  // Put a file that was moved aside back, when the name is still free. The hard
  // link goes first; the rename is for what cannot be linked (a directory) and
  // counts only when the moved-aside name is gone afterwards.
  'restore() {',
  '  if [ "$old" -ef "./$n" ] || ln -T -- "$old" "./$n" 2>/dev/null; then rm -f "$old"; return 0; fi',
  '  mv -nT -- "$old" "./$n" 2>/dev/null && [ ! -e "$old" ] && [ ! -L "$old" ]',
  '}',
  // However the script ends, the temporary file (which holds the enrollment
  // token) goes, and a file moved aside for a replacement goes back, unless the
  // new file was already published (the name and the temporary file are the same
  // file), when the old one just goes. Whether a signal landed before or after
  // the move is told by the slot, never by the name: the slot is still the empty
  // file made for it until the rename lands, and holds the original afterwards,
  // whatever has appeared at the name since. Anything moved aside that was not
  // validated is never removed: when it cannot go back, it stays under its slot
  // name and the script says so.
  'cleanup() {',
  '  if [ -e "$t" ] && [ "./$n" -ef "$t" ]; then published=1; fi',
  '  rm -f "$t"',
  '  if [ "$moving" = 1 ] && [ -n "$slot" ] && { [ -e "$slot" ] || [ -L "$slot" ]; } && [ "$(stat -c "%d:%i" -- "$slot" 2>/dev/null)" != "$slot_id" ]; then old=$slot; slot=; fi',
  '  if [ -n "$slot" ]; then rm -f "$slot"; fi',
  '  if [ -n "$old" ]; then',
  '    if [ "$published" = 1 ]; then rm -f "$old"; elif ! restore; then echo "the file that was there is kept as $d/${old#./}" >&2; fi',
  '  fi',
  '}',
  'trap cleanup EXIT',
  // A dropped session ends the shell through a signal (or a write to a closed
  // pipe), which skips the exit trap unless the signal is turned into an exit.
  'trap \'exit 1\' HUP INT TERM PIPE',
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
  '  slot=$(mktemp "./.$n.old.XXXXXX")',
  '  slot_id=$(stat -c "%d:%i" -- "$slot")',
  '  moving=1',
  '  if mv -fT -- "./$n" "$slot" 2>/dev/null; then old=$slot; slot=; fi',
  '  moving=0',
  '  if [ -n "$slot" ]; then rm -f "$slot"; slot=; fi',
  '  if [ -n "$old" ]; then',
  '    if [ -L "$old" ] || [ ! -f "$old" ] || [ "$(sha256sum "$old" | cut -d\' \' -f1)" != "$ph" ]; then',
  '      if restore; then',
  '        echo "changed since it was inspected: $d/$n" >&2',
  '      else',
  '        echo "changed since it was inspected: $d/$n; the file that was there is kept as $d/${old#./}" >&2',
  '      fi',
  '      old=',
  `      exit ${WRITE_EXIT.exists}`,
  '    fi',
  '  fi',
  'fi',
  // A hard link publishes only when the name is free, atomically; unlike a
  // rename it cannot replace a file another process created after the check.
  // The file moved aside is the one that was inspected and matched, so it is
  // what the replacement was approved to remove.
  'if ! ln -T -- "$t" "./$n" 2>/dev/null; then',
  '  if [ -e "./$n" ] || [ -L "./$n" ]; then',
  '    rm -f "$old"; old=',
  `    echo "already exists: $d/$n" >&2; exit ${WRITE_EXIT.exists}`,
  '  fi',
  `  echo "could not publish: $d/$n" >&2; exit ${WRITE_EXIT.notPublished}`,
  'fi',
  'published=1',
  'if [ -n "$old" ]; then rm -f "$old"; old=; fi',
].join('\n');

/**
 * Write standard input to `filePath`: a temporary file in the same directory
 * must hash to `sha256`, then gets the mode and owner and is published by a
 * hard link, which refuses a name that already holds anything (a file, a
 * symlink or a directory), even one created after the content arrived. With
 * `replaces` (the sha256 of the file the executor inspected) the entry at the
 * name is first moved aside and must be that file; anything else is put back
 * when the name is still free (or kept under a `.old` name the error gives)
 * and the write is refused. The directory is entered once and every name is
 * relative to it, so a symlink swapped in for the directory or one of its
 * ancestors after the check is refused instead of followed. `directory` is the
 * physical path of the file's directory that the plan approved (see
 * `approvedDirectory`): the directory the shell enters must be exactly that one.
 */
export function writeFileCommand(
  filePath: string,
  file: { mode: string; owner: string; group: string; sha256: string },
  options: { sudo: boolean; replaces: string | null; directory: string },
): string {
  const args = [
    path.posix.dirname(filePath),
    path.posix.basename(filePath),
    file.mode,
    file.owner,
    file.group,
    options.replaces ?? '',
    file.sha256,
    options.directory,
  ].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(WRITE_SCRIPT)} sencho-write ${args}`, options.sudo);
}

const DIRECTORY_SCRIPT = [
  'set -eu',
  'umask 077',
  'p=$1; m=$2; o=$3; g=$4; keep=$5; e=$6',
  ENTER_DIRECTORY,
  ENTER_VIA_LINKS,
  `case $p in /*) ;; *) echo "not an absolute path: $p" >&2; exit ${WRITE_EXIT.notDirectory} ;; esac`,
  'made=0',
  // What mkdir leaves under umask 077 (the setgid bit comes from a parent that has it).
  'fresh() {',
  '  [ -O . ] && [ -z "$(ls -A)" ] || return 1',
  '  case $(stat -c "%a" -- .) in 700|2700) ;; *) return 1 ;; esac',
  '}',
  // Once something was created, a refusal is an unfinished change, not a clean one.
  'die() { code=$1; shift; echo "$*" >&2; if [ "$made" = 1 ]; then code=' + WRITE_EXIT.unfinished + '; fi; exit "$code"; }',
  // The deepest ancestor that exists; the names below it are created one at a time.
  'anc=$p; below=',
  'while [ ! -e "$anc" ] && [ ! -L "$anc" ]; do',
  '  below="/${anc##*/}$below"',
  '  anc=${anc%/*}',
  '  [ -n "$anc" ] || anc=/',
  'done',
  'if [ -z "$below" ]; then',
  // The name exists already: only a real directory may be adjusted, and only when allowed.
  `  if [ "$keep" != 1 ] || [ -L "$p" ] || [ ! -d "$p" ]; then die ${WRITE_EXIT.exists} "already exists: $p"; fi`,
  `  enter "$p" "$e" || die ${WRITE_EXIT.notDirectory} "not the approved directory, or it changed: $p"`,
  'else',
  // The approved path is the physical path of the whole directory; what exists
  // now is its front part, and the rest is what is made below it.
  `  case $e in *"$below") want=\${e%"$below"} ;; *) die ${WRITE_EXIT.notDirectory} "not the approved directory: $p" ;; esac`,
  '  [ -n "$want" ] || want=/',
  `  enter_via "$anc" "$want" || die ${WRITE_EXIT.notDirectory} "not the approved directory, or it changed: $anc"`,
  '  rest=${below#/}',
  '  while [ -n "$rest" ]; do',
  '    c=${rest%%/*}',
  '    case $rest in */*) rest=${rest#*/} ;; *) rest= ;; esac',
  // mkdir never follows or replaces an existing name, a symlink included, so a
  // name taken since the plan was approved is refused, not changed. A parent
  // that appeared meanwhile as a real directory is simply entered, and left as it is.
  '    created=0',
  '    if mkdir -- "./$c" 2>/dev/null; then',
  '      made=1; created=1',
  '    elif [ -n "$rest" ] && [ ! -L "./$c" ] && [ -d "./$c" ]; then',
  '      :',
  '    elif [ -e "./$c" ] || [ -L "./$c" ]; then',
  `      die ${WRITE_EXIT.exists} "already exists: $p"`,
  '    else',
  `      die ${WRITE_EXIT.notCreated} "could not create: $p"`,
  '    fi',
  '    want=${want%/}/$c',
  `    enter "./$c" "$want" || die ${WRITE_EXIT.notDirectory} "changed while it was set up: $p"`,
  // The name was free when mkdir ran, but what the shell entered is only the
  // directory mkdir made if nothing else was put at the name in between. A
  // directory made here is empty, owned by this user and has exactly the
  // mode mkdir gave it; anything else was put there by someone else and is
  // not touched.
  `    if [ "$created" = 1 ]; then fresh || die ${WRITE_EXIT.unfinished} "changed while it was set up: $p"; fi`,
  // A directory this script works in is owned by the user it runs as. One that
  // is not was put there by someone else, even if it appeared as a parent in the
  // meantime, and nothing is made inside it. Only a directory it made itself
  // gets the parent mode.
  `    [ -O . ] || die ${WRITE_EXIT.unfinished} "changed while it was set up: $p"`,
  // Parents get the usual 0755 (install -d did the same); the mode and owner below are for the directory itself.
  `    if [ "$created" = 1 ] && [ -n "$rest" ]; then chmod 0755 . || die ${WRITE_EXIT.unfinished} "could not set the mode of a parent of $p"; fi`,
  '  done',
  'fi',
  `chown "$o:$g" . || die ${WRITE_EXIT.unfinished} "could not set the owner of $p"`,
  `chmod "$m" . || die ${WRITE_EXIT.unfinished} "could not set the mode of $p"`,
].join('\n');

/**
 * Create the directory `dirPath` and any missing parents (as `install -d`
 * did) with the mode and owner, changing only directories it created. A name
 * that exists is refused, a symlink never followed; `allowExisting` accepts an
 * existing real directory (the apt keyring directory) and applies the mode and
 * owner to that directory itself, never through a symlink. The nearest existing
 * ancestor may itself be a symlink, which the plan discloses; it is entered
 * once and the new directories are made inside the directory it led to.
 * `approved` is the physical path the plan approved for `dirPath`: every
 * directory the script enters must be on the way to exactly that path, so an
 * ancestor swapped before the script started is refused. A directory it makes
 * is changed only when it is empty and still has the mode and owner it was
 * made with.
 */
export function createDirectoryCommand(
  dirPath: string,
  dir: { mode: string; owner: string; group: string },
  options: { sudo: boolean; allowExisting: boolean; approved: string },
): string {
  const args = [dirPath, dir.mode, dir.owner, dir.group, options.allowExisting ? '1' : '0', options.approved].map(shellQuote).join(' ');
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
