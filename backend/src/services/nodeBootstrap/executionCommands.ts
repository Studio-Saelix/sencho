import path from 'path';
import { DOCKER_LOCAL_ASSIGNMENTS, DOCKER_LOCAL_ENV, DOCKER_LOCAL_UNSET_ARGS } from './probes';
import { PILOT_CONTAINER_NAME, PILOT_PROJECT_NAME, shellQuote } from './pathPolicy';

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
 * The directory a script may enter is bound to the directory that was
 * approved, not to its name. `$identity` is either what the preflight (or the
 * step that made the directory) recorded for it, or the word `system` for a
 * system directory the preflight does not inspect (the apt keyring and source
 * directories): those must be owned by the user the script runs as, which is
 * root under sudo, so an unprivileged process cannot put a directory of its own
 * there.
 *
 * An identity is `<device>:<inode>:<owner uid>:<birth time>` (see
 * `ident`). The device and inode alone are not enough: a directory that was
 * removed and made again often gets the same inode number back, so a
 * substitute with an unrelated owner, mode and content could carry the
 * approved identity. The birth time of the new directory differs, and so does
 * its owner when another user made it. A filesystem that does not record birth
 * times reports `-` there, and the identity then rests on the first three
 * parts. `$made` (the directory script only) lists directories earlier steps
 * of the same run made, one `<identity><tab><physical path>` per line: a
 * directory the plan could not name, because it did not exist when the plan was
 * approved, is accepted when it is one of those at the path it was made.
 */
const BIND_DIRECTORY = [
  'ident() { stat -c "%d:%i:%u:%w" -- "$1" 2>/dev/null | tr -d " "; }',
  'bound() {',
  '  if [ "$1" = system ]; then [ -O . ]; return; fi',
  '  now=$(ident .)',
  '  [ -n "$now" ] || return 1',
  '  [ "$now" = "$1" ] && return 0',
  '  [ -n "${made-}" ] || return 1',
  '  printf "%s\\n" "$made" | grep -qxF -- "$now$(printf "\\t")$2"',
  '}',
].join('\n');

/**
 * Enter a directory without trusting its name twice, and only if it is the
 * directory that was approved. The name is inspected without following a final
 * symlink (it must be a directory), the shell changes into it, the directory it
 * is in must be the one inspected (same identity), its physical path
 * (`pwd -P`) must be the one the plan approved ($2), and it must be the
 * directory the approval recorded ($3, see BIND_DIRECTORY): a name or an
 * ancestor swapped for a symlink or another directory, before this script
 * started or in between, refuses here, before anything is changed. Every later
 * operation uses names relative to the directory the shell holds, so a swap
 * after this point cannot redirect it.
 */
const ENTER_DIRECTORY = [
  BIND_DIRECTORY,
  'enter() {',
  '  before=$(stat -c "%F:%d:%i" -- "$1" 2>/dev/null) || before=',
  '  case $before in directory:*) ;; *) return 1 ;; esac',
  '  cd -P -- "$1" 2>/dev/null || return 1',
  '  [ "$(stat -c "%F:%d:%i" -- . 2>/dev/null)" = "$before" ] || return 1',
  '  [ "$(pwd -P)" = "$2" ] || return 1',
  '  bound "$3" "$2"',
  '}',
].join('\n');

/** The same pinning for a name whose own symlink is fine: an ancestor of a new directory may be one, and the plan shows where it leads. */
const ENTER_VIA_LINKS = [
  'enter_via() {',
  '  before=$(stat -L -c "%F:%d:%i" -- "$1" 2>/dev/null) || before=',
  '  case $before in directory:*) ;; *) return 1 ;; esac',
  '  cd -P -- "$1" 2>/dev/null || return 1',
  '  [ "$(stat -c "%F:%d:%i" -- . 2>/dev/null)" = "$before" ] || return 1',
  '  [ "$(pwd -P)" = "$2" ] || return 1',
  '  bound "$3" "$2"',
  '}',
].join('\n');

const WRITE_SCRIPT = [
  'set -eu',
  'umask 077',
  'd=$1; n=$2; m=$3; o=$4; g=$5; ph=$6; h=$7; e=$8; i=$9',
  ENTER_DIRECTORY,
  `enter "$d" "$e" "$i" || { echo "not the approved directory, or it changed: $d" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
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
  // name, and the script says so on standard error (which only reaches the
  // caller while the session lives). A second signal must not cut the cleanup
  // short, so signals are ignored while it runs.
  'cleanup() {',
  "  trap '' HUP INT TERM PIPE",
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
 * `approvedDirectory`) and `binding` the identity recorded for it: the
 * directory the shell enters must be exactly that one.
 */
export function writeFileCommand(
  filePath: string,
  file: { mode: string; owner: string; group: string; sha256: string },
  options: { sudo: boolean; replaces: string | null; directory: string; binding: DirectoryBinding },
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
    options.binding,
  ].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(WRITE_SCRIPT)} sencho-write ${args}`, options.sudo);
}

/**
 * The directory a script is bound to: the identity the approval recorded for
 * it, or `system` for a system directory the preflight does not inspect (see
 * BIND_DIRECTORY).
 */
export type DirectoryBinding = string;
export const SYSTEM_DIRECTORY: DirectoryBinding = 'system';

/** A line of the directory script's standard output for each directory it made: `<identity><tab><physical path>`. */
export const DIRECTORY_MADE_PREFIX = 'SENCHO_DIR_MADE=';

/** The standard input of the directory script: the directories earlier steps of the run made (see BIND_DIRECTORY). */
export function madeDirectoriesInput(made: ReadonlyMap<string, string>): string {
  return [...made].map(([directory, identity]) => `${identity}\t${directory}\n`).join('');
}

const DIRECTORY_SCRIPT = [
  'set -eu',
  'umask 077',
  'p=$1; m=$2; o=$3; g=$4; keep=$5; e=$6; i=$7',
  // The directories earlier steps of this run made (the caller always sends standard input).
  'made=$(cat)',
  ENTER_DIRECTORY,
  ENTER_VIA_LINKS,
  `case $p in /*) ;; *) echo "not an absolute path: $p" >&2; exit ${WRITE_EXIT.notDirectory} ;; esac`,
  // The deepest ancestor that exists; the names below it are created one at a time.
  'anc=$p; below=',
  'while [ ! -e "$anc" ] && [ ! -L "$anc" ]; do',
  '  below="/${anc##*/}$below"',
  '  anc=${anc%/*}',
  '  [ -n "$anc" ] || anc=/',
  'done',
  'if [ -z "$below" ]; then',
  // The name exists already: only a real directory may be adjusted, and only
  // when allowed, and only if it is the directory that was approved.
  `  if [ "$keep" != 1 ] || [ -L "$p" ] || [ ! -d "$p" ]; then echo "already exists: $p" >&2; exit ${WRITE_EXIT.exists}; fi`,
  `  enter "$p" "$e" "$i" || { echo "not the approved directory, or it changed: $p" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
  `  chown "$o:$g" . || { echo "could not set the owner of $p" >&2; exit ${WRITE_EXIT.unfinished}; }`,
  `  chmod "$m" . || { echo "could not set the mode of $p" >&2; exit ${WRITE_EXIT.unfinished}; }`,
  '  exit 0',
  'fi',
  // The approved path is the physical path of the whole directory; what exists
  // now is its front part, and the rest is what is made below it.
  `case $e in *"$below") want=\${e%"$below"} ;; *) echo "not the approved directory: $p" >&2; exit ${WRITE_EXIT.notDirectory} ;; esac`,
  '[ -n "$want" ] || want=/',
  `enter_via "$anc" "$want" "$i" || { echo "not the approved directory, or it changed: $anc" >&2; exit ${WRITE_EXIT.notDirectory}; }`,
  'aid=$(ident .)',
  // Nothing is made at the final name until it is complete. The new directories
  // are built inside a private staging directory (an unpredictable name in the
  // directory held above), so nothing another process puts at the final name
  // can be mistaken for what this script made and changed; the topmost new name
  // is then moved into place in one rename that refuses an occupied name.
  'first=${below#/}; first=${first%%/*}',
  'stage=; d_stage=; sid=; inside=0; published=0; top=; rel=; acc=$want; mnew=',
  "nl=$(printf '\\n_'); nl=${nl%_}",
  'cleanup() {',
  "  trap '' HUP INT TERM PIPE",
  '  [ -n "$stage" ] || return 0',
  '  left=0',
  '  if [ "$inside" = 1 ]; then',
  // Removed by the names the script would have made, deepest first (not by the
  // last name it recorded: a stop can land between the mkdir and the record),
  // and only while empty: rmdir never removes anything with something in it.
  '    if [ "$published" = 0 ]; then',
  '      pr=${below#/}',
  '      while [ -n "$pr" ]; do',
  '        rmdir -- "./$pr" 2>/dev/null || true',
  '        case $pr in */*) pr=${pr%/*} ;; *) pr= ;; esac',
  '      done',
  '      if [ -e "./$first" ] || [ -L "./$first" ]; then left=1; fi',
  '    fi',
  '    cd .. 2>/dev/null || left=1',
  '    [ "$(ident .)" = "$aid" ] || left=1',
  '  else',
  '    left=1',
  '  fi',
  '  if [ "$left" = 0 ]; then',
  '    if [ "$(ident "$stage")" = "$sid" ]; then rmdir -- "$stage" 2>/dev/null || left=1; else left=1; fi',
  '  fi',
  `  if [ "$left" = 1 ]; then echo "set-up of $p left a staging directory behind: $d_stage" >&2; exit ${WRITE_EXIT.unfinished}; fi`,
  '}',
  'trap cleanup EXIT',
  'trap \'exit 1\' HUP INT TERM PIPE',
  `stage=$(mktemp -d "./.sencho-new.XXXXXX" 2>/dev/null) || { stage=; echo "could not create: $p" >&2; exit ${WRITE_EXIT.notCreated}; }`,
  'd_stage="$anc/${stage#./}"',
  'sid=$(ident "$stage") || sid=',
  `cd -P -- "$stage" 2>/dev/null && [ "$(ident .)" = "$sid" ] && [ "$(ident ..)" = "$aid" ] || { echo "changed while it was set up: $p" >&2; exit ${WRITE_EXIT.unfinished}; }`,
  'inside=1',
  'rest=${below#/}',
  'while [ -n "$rest" ]; do',
  '  c=${rest%%/*}',
  '  case $rest in */*) rest=${rest#*/}; more=1 ;; *) rest=; more=0 ;; esac',
  '  next=${rel:+$rel/}$c',
  `  mkdir -- "./$next" 2>/dev/null || { echo "could not create: $p" >&2; exit ${WRITE_EXIT.notCreated}; }`,
  // What was made so far is what a stop or a failure removes, deepest first.
  '  rel=$next; acc=${acc%/}/$c',
  '  [ -n "$top" ] || top=$c',
  // A parent keeps the owner it was made with; the directory itself is recorded below, once it has its planned owner.
  '  if [ "$more" = 1 ]; then mnew="$mnew$(ident "./$rel")$(printf "\\t")$acc$nl"; fi',
  // A parent gets mode 0755; the planned mode and owner below are for the directory itself.
  `  if [ "$more" = 1 ]; then chmod 0755 -- "./$rel" 2>/dev/null || { echo "could not set the mode of a parent of $p" >&2; exit ${WRITE_EXIT.notCreated}; }; fi`,
  'done',
  `chown "$o:$g" -- "./$rel" 2>/dev/null || { echo "could not set the owner of $p" >&2; exit ${WRITE_EXIT.notCreated}; }`,
  `chmod "$m" -- "./$rel" 2>/dev/null || { echo "could not set the mode of $p" >&2; exit ${WRITE_EXIT.notCreated}; }`,
  // The identity includes the owner, which the chown above may have changed (a directory made as root and handed over).
  'topid=$(ident "./$top"); leafid=$(ident "./$rel")',
  'mnew="$mnew$leafid$(printf "\\t")$acc$nl"',
  `[ "$(ident ..)" = "$aid" ] || { echo "changed while it was set up: $p" >&2; exit ${WRITE_EXIT.notCreated}; }`,
  // The rename is told not to replace; where mv checks first instead, whatever
  // is at the name is seen in the check, and a name taken in between can only be
  // an empty directory, which is the one thing a rename may replace.
  `if [ -e "../$top" ] || [ -L "../$top" ]; then echo "already exists: $p" >&2; exit ${WRITE_EXIT.exists}; fi`,
  'mv -nT -- "./$top" "../$top" 2>/dev/null || true',
  `if [ -e "./$top" ] || [ -L "./$top" ]; then echo "already exists: $p" >&2; exit ${WRITE_EXIT.exists}; fi`,
  'published=1',
  // From here the directory is in place; what it is must be what was made.
  `[ "$(ident "../$top")" = "$topid" ] && [ "$(ident "../$rel")" = "$leafid" ] || { echo "changed while it was set up: $p" >&2; exit ${WRITE_EXIT.unfinished}; }`,
  `printf '%s' "$mnew" | sed 's/^/${DIRECTORY_MADE_PREFIX}/'`,
].join('\n');

/**
 * Create the directory `dirPath` and any missing parents with the mode and
 * owner (parents get 0755), changing only directories it built itself, plus
 * the one existing directory `allowExisting` accepts. A name that exists is
 * refused, a symlink never followed; `allowExisting` accepts an existing real
 * directory (the apt keyring directory) and applies the mode and owner to that
 * directory itself, never through a symlink. The nearest existing ancestor may
 * itself be a symlink, which the plan discloses; it is entered once and the new
 * directories are made inside the directory it led to.
 *
 * `approved` is the physical path the plan approved for `dirPath` and
 * `binding` the identity (see BIND_DIRECTORY) of the directory the script
 * starts from: the nearest existing ancestor, or the existing directory itself
 * under `allowExisting`. Every directory the script enters must be on the way
 * to exactly that path and be that very directory, so an ancestor swapped
 * before the script started is refused. The script reads the directories earlier
 * steps of the run made from standard input (`madeDirectoriesInput`; the caller
 * always sends it), because a second directory made below a parent the first
 * one created starts from a directory the plan could not name.
 *
 * A new directory is built in a private staging directory and moved into place
 * whole, so no directory at the final name is ever changed in place. A run that
 * built one ends by printing a `SENCHO_DIR_MADE=` line (identity, a tab, the
 * physical path) for each directory it made, the parents included.
 */
export function createDirectoryCommand(
  dirPath: string,
  dir: { mode: string; owner: string; group: string },
  options: { sudo: boolean; allowExisting: boolean; approved: string; binding: DirectoryBinding },
): string {
  const args = [dirPath, dir.mode, dir.owner, dir.group, options.allowExisting ? '1' : '0', options.approved, options.binding].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(DIRECTORY_SCRIPT)} sencho-mkdir ${args}`, options.sudo);
}

/**
 * Exit codes of the start script: a directory that is not the approved one, an
 * input file that is not the file the plan names, and standard input that
 * ended before the script had everything it compares against. They are kept
 * apart from the codes Docker and Compose exit with, so a refusal is never
 * mistaken for the start having begun (or the reverse).
 */
export const START_EXIT = { notDirectory: 70, inputChanged: 71, inputIncomplete: 72 } as const;

const START_SCRIPT = [
  'set -eu',
  'd=$1; e=$2; c=$3; ce=$4',
  // What the directories and files must be arrives on standard input: the
  // identities are only known once the run has made or re-found its
  // directories, and the compose file carries a token that is not in the plan.
  'IFS= read -r id || id=',
  'IFS= read -r cid || cid=',
  'IFS= read -r csha || csha=',
  'IFS= read -r casha || casha=',
  // A session that dropped inside the last value would otherwise read as "no hub CA", which skips its check.
  'IFS= read -r end || end=',
  `[ "$end" = end ] || { echo "the start input is incomplete" >&2; exit ${START_EXIT.inputIncomplete}; }`,
  ENTER_DIRECTORY,
  `enter "$d" "$e" "$id" || { echo "not the approved directory, or it changed: $d" >&2; exit ${START_EXIT.notDirectory}; }`,
  // The Compose directory is bind-mounted by the name the compose file gives it,
  // which the daemon resolves on its own: it must still be the approved one now.
  `( enter "$c" "$ce" "$cid" ) || { echo "not the approved Compose directory, or it changed: $c" >&2; exit ${START_EXIT.notDirectory}; }`,
  'hash_of() { sha256sum -- "$1" | cut -d" " -f1; }',
  'inputs_ok() {',
  '  [ ! -L "./$1" ] && [ -f "./$1" ] && [ "$(hash_of "./$1")" = "$2" ]',
  '}',
  `inputs_ok compose.yaml "$csha" || { echo "compose.yaml is not the file that was written" >&2; exit ${START_EXIT.inputChanged}; }`,
  `if [ -n "$casha" ]; then inputs_ok sencho-hub-ca.pem "$casha" || { echo "sencho-hub-ca.pem is not the file that was written" >&2; exit ${START_EXIT.inputChanged}; }; fi`,
  // Compose reads its own files relative to the directory the shell holds, never
  // through the name that was approved (the daemon still resolves the bind-mounted paths itself). Both the Docker endpoint and the Compose
  // project are pinned: a configured remote context or ambient Compose variable
  // must not change which daemon or project this starts.
  `exec env ${DOCKER_LOCAL_UNSET_ARGS} -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES ${DOCKER_LOCAL_ASSIGNMENTS} docker compose --project-name ${PILOT_PROJECT_NAME} --project-directory . -f ./compose.yaml up -d`,
].join('\n');

/**
 * Start the Pilot project from the directory the plan approved, without opening
 * its name again: the script enters the directory by identity, checks that the
 * Compose directory the compose file mounts is still the approved one and that
 * `compose.yaml` and the hub CA are the files the plan names (by SHA-256), then runs
 * Compose against the directory it holds. Standard input carries, one per line,
 * the identity of the agent directory, the identity of the Compose directory,
 * the sha256 of the compose file, the sha256 of the hub CA (empty when the
 * plan has none) and the word `end`, without which the input is refused as cut
 * short; see `startInput`.
 */
export function startProjectCommand(
  agentDir: { path: string; approved: string },
  composeDir: { path: string; approved: string },
  sudo: boolean,
): string {
  const args = [agentDir.path, agentDir.approved, composeDir.path, composeDir.approved].map(shellQuote).join(' ');
  return withSudo(`sh -c ${shellQuote(START_SCRIPT)} sencho-start ${args}`, sudo);
}

/** The standard input `startProjectCommand` reads. */
export function startInput(input: { agentIdentity: string; composeIdentity: string; composeSha256: string; caSha256: string | null }): string {
  return `${input.agentIdentity}\n${input.composeIdentity}\n${input.composeSha256}\n${input.caSha256 ?? ''}\nend\n`;
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
