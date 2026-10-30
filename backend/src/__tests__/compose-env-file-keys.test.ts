/**
 * The key-name reader used by the node summary must see every assignment,
 * including Compose's inherited form where the file ends right after the name.
 */
import { describe, expect, it } from 'vitest';
import { ComposeEnvFiles, composeEnvFileKeyNames } from '../utils/composeDotenv';

describe('service env_file key names', () => {
  it('keeps a bare final key as an inherited assignment', () => {
    expect(composeEnvFileKeyNames('A=1\nB')).toEqual(['A', 'B']);
    const reader = new ComposeEnvFiles(name => (name === 'B' ? 'from-process' : undefined));
    reader.read('A=1\nB');
    expect(reader.lookup('B')).toBe('from-process');
  });

  it('separates a file assignment from the interpolation environment', () => {
    const reader = new ComposeEnvFiles(name => name === 'TS_EXTRA_ARGS' ? '--accept-dns=false' : undefined);
    reader.read('TS_EXTRA_ARGS=--advertise-exit-node\n');
    expect(reader.lookup('TS_EXTRA_ARGS')).toBe('--accept-dns=false');
    expect(reader.assigned('TS_EXTRA_ARGS')).toBe('--advertise-exit-node');
  });

  it('returns keys but never values', () => {
    expect(composeEnvFileKeyNames('TUNNEL_TOKEN=secret\nTS_EXTRA_ARGS=--advertise-exit-node\n'))
      .toEqual(['TUNNEL_TOKEN', 'TS_EXTRA_ARGS']);
  });
});
