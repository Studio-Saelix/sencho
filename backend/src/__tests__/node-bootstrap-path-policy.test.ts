import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_DIR,
  DEFAULT_COMPOSE_DIR,
  arePathsDisjoint,
  isAtOrBelowPath,
  shellQuote,
  validatePathSyntax,
} from '../services/nodeBootstrap/pathPolicy';

describe('bootstrap path policy', () => {
  it('accepts both defaults', () => {
    expect(validatePathSyntax(DEFAULT_COMPOSE_DIR, 'compose').ok).toBe(true);
    expect(validatePathSyntax(DEFAULT_AGENT_DIR, 'agent').ok).toBe(true);
    expect(validatePathSyntax('/srv/sencho-stacks', 'compose').normalized).toBe('/srv/sencho-stacks');
    expect(validatePathSyntax('/opt/docker/apps', 'compose').ok).toBe(true);
    expect(validatePathSyntax('/home/ubuntu/stacks', 'compose').ok).toBe(true);
    expect(validatePathSyntax('/var/lib/sencho/stacks', 'compose').ok).toBe(true);
  });

  const invalid: Array<[string, string]> = [
    ['relative/path', 'not-absolute'],
    ['~/stacks', 'not-absolute'],
    ['', 'not-absolute'],
    ['/opt/docker/../etc', 'dot-segment'],
    ['/opt/./sencho', 'dot-segment'],
    ['/opt/docker/sencho/', 'trailing-slash'],
    ['/opt//docker/sencho', 'empty-segment'],
    ['/', 'root'],
    ['/opt', 'too-shallow'],
    ['/opt', 'too-shallow'],
    ['/etc', 'too-shallow'],
    ['/etc/stacks', 'reserved'],
    ['/usr/local/stacks', 'reserved'],
    ['/var/lib/docker/stacks', 'reserved'],
    ['/app/stacks', 'reserved'],
    ['/tmp/stacks', 'reserved'],
    ['/run/stacks', 'reserved'],
    ['/opt/docker/my stacks', 'bad-character'],
    ['/opt/docker/$stacks', 'bad-character'],
    ['/opt/docker/`stacks`', 'bad-character'],
    ['/opt/docker/sta"cks', 'bad-character'],
    ['/opt/docker/sta\ncks', 'bad-character'],
    ['/opt/docker/stàcks', 'bad-character'],
    [`/opt/${'a'.repeat(220)}/stacks`, 'too-long'],
  ];

  it.each(invalid)('rejects %s as %s', (path, reason) => {
    const result = validatePathSyntax(path, 'compose');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.message).toBeTruthy();
  });

  it('names a usable example in the character-set message', () => {
    const result = validatePathSyntax('/opt/docker/my stacks', 'agent');
    expect(result.message).toContain('A-Z a-z 0-9 . _ - /');
    expect(result.message).toContain('/opt/docker/sencho');
  });

  it('treats boundary names as disjoint and nesting as a conflict', () => {
    expect(arePathsDisjoint('/opt/docker/sencho', '/opt/docker/sencho-agent').ok).toBe(true);
    expect(arePathsDisjoint('/opt/sencho', '/opt/sencho-agent').ok).toBe(true);
    expect(arePathsDisjoint('/opt/docker/sencho', '/opt/docker/sencho').reason).toBe('equal');
    expect(arePathsDisjoint('/opt/sencho', '/opt/sencho/agent').reason).toBe('agent-inside-compose');
    expect(arePathsDisjoint('/opt/sencho/agent', '/opt/sencho').reason).toBe('compose-inside-agent');
  });

  it('treats a shared string prefix that is not a path boundary as disjoint', () => {
    expect(isAtOrBelowPath('/opt/sencho-agent', '/opt/sencho')).toBe(false);
    expect(isAtOrBelowPath('/opt/sencho/agent', '/opt/sencho')).toBe(true);
    expect(isAtOrBelowPath('/opt/sencho', '/opt/sencho')).toBe(true);
  });

  it('shell-quotes without leaving a way out of the single quotes', () => {
    expect(shellQuote('/opt/docker/sencho')).toBe("'/opt/docker/sencho'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
