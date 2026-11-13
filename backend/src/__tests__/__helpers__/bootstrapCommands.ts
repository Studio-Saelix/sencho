import fs from 'fs';
import path from 'path';
import { createDirectoryCommand, writeFileCommand } from '../../services/nodeBootstrap/executionCommands';

/**
 * The physical path the preflight would record for `target` (`realpath -m`):
 * the deepest existing ancestor resolved through its links, then the names
 * that do not exist yet. Taken when a command is built, as the plan is, so a
 * test that swaps a directory afterwards swaps it after the approval.
 */
export function approvedPath(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(existing) && !isLink(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

function isLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The identity the preflight would record for the directory `target` resolves
 * to now: its device and inode, taken through any link, or those of the nearest
 * existing ancestor when it does not exist yet.
 */
export function approvedIdentity(target: string): string {
  let existing = path.resolve(target);
  while (!fs.existsSync(existing) && !isLink(existing)) existing = path.dirname(existing);
  const stat = fs.statSync(existing, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

type WriteOptions = { sudo: boolean; replaces: string | null; directory?: string; binding?: string };
type DirectoryOptions = { sudo: boolean; allowExisting: boolean; approved?: string; binding?: string };

/** `writeFileCommand` for a directory approved as it is on this machine now, unless a test names another. */
export function writeCommand(
  filePath: string,
  file: Parameters<typeof writeFileCommand>[1],
  options: WriteOptions,
): string {
  const directory = options.directory ?? approvedPath(path.dirname(filePath));
  return writeFileCommand(filePath, file, { ...options, directory, binding: options.binding ?? approvedIdentity(path.dirname(filePath)) });
}

/** `createDirectoryCommand` for a path approved as it resolves on this machine now, unless a test names another. */
export function directoryCommand(
  dirPath: string,
  dir: Parameters<typeof createDirectoryCommand>[1],
  options: DirectoryOptions,
): string {
  return createDirectoryCommand(dirPath, dir, { ...options, approved: options.approved ?? approvedPath(dirPath), binding: options.binding ?? approvedIdentity(dirPath) });
}
