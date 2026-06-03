import { describe, it, expect } from 'vitest';
import path from 'path';
import { isManagedByComposeDir } from '../utils/managed-containers';

const COMPOSE_DIR = path.resolve('/srv/compose');

function withWorkingDir(workingDir?: string): { Labels?: Record<string, string> } {
  return workingDir === undefined
    ? {}
    : { Labels: { 'com.docker.compose.project.working_dir': workingDir } };
}

describe('isManagedByComposeDir', () => {
  it('treats a container in a subdirectory of COMPOSE_DIR as managed', () => {
    expect(isManagedByComposeDir(withWorkingDir(path.join(COMPOSE_DIR, 'web')), COMPOSE_DIR)).toBe(true);
  });

  it('treats a container launched from the COMPOSE_DIR root as managed', () => {
    expect(isManagedByComposeDir(withWorkingDir(COMPOSE_DIR), COMPOSE_DIR)).toBe(true);
  });

  it('treats a container outside COMPOSE_DIR as unmanaged', () => {
    expect(isManagedByComposeDir(withWorkingDir('/opt/other/stack'), COMPOSE_DIR)).toBe(false);
  });

  it('does not match a sibling directory that shares the COMPOSE_DIR prefix', () => {
    // /srv/compose-extra must not be considered inside /srv/compose.
    expect(isManagedByComposeDir(withWorkingDir(`${COMPOSE_DIR}-extra/web`), COMPOSE_DIR)).toBe(false);
  });

  it('treats a container with no compose working-dir label as unmanaged', () => {
    expect(isManagedByComposeDir(withWorkingDir(undefined), COMPOSE_DIR)).toBe(false);
    expect(isManagedByComposeDir({ Labels: {} }, COMPOSE_DIR)).toBe(false);
  });
});
