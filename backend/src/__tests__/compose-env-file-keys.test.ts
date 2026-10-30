/**
 * The names a service env_file assigns are what Compose puts in the container's
 * environment: read in file order with the same interpolation as the values, so
 * a name that only inherits an unset variable is absent, and a `format: raw`
 * file is read literally.
 */
import { describe, expect, it } from 'vitest';
import { ComposeEnvFileError, ComposeEnvFiles } from '../utils/composeDotenv';

const none = () => undefined;

describe('service env_file assigned names', () => {
  it('keeps a bare final key as an inherited assignment only when the variable is set', () => {
    const set = new ComposeEnvFiles(name => (name === 'B' ? 'from-process' : undefined));
    set.read('A=1\nB');
    expect(set.assignedNames()).toEqual(['A', 'B']);
    expect(set.lookup('B')).toBe('from-process');
    const unset = new ComposeEnvFiles(none);
    unset.read('A=1\nB');
    expect(unset.assignedNames()).toEqual(['A']);
  });

  it('leaves out an inherited name with no value, with or without export', () => {
    const files = new ComposeEnvFiles(none);
    files.read('TUNNEL_TOKEN\nexport TUNNEL_TOKEN_FILE\nEMPTY=\n');
    expect(files.assignedNames()).toEqual(['EMPTY']);
  });

  it('separates a file assignment from the interpolation environment', () => {
    const reader = new ComposeEnvFiles(name => name === 'TS_EXTRA_ARGS' ? '--accept-dns=false' : undefined);
    reader.read('TS_EXTRA_ARGS=--advertise-exit-node\n');
    expect(reader.lookup('TS_EXTRA_ARGS')).toBe('--accept-dns=false');
    expect(reader.assigned('TS_EXTRA_ARGS')).toBe('--advertise-exit-node');
  });

  it('resolves a required reference through an earlier assignment in the same file or the project environment', () => {
    const files = new ComposeEnvFiles(name => (name === 'FROM_PROJECT' ? '--advertise-routes=10.0.0.0/8' : undefined));
    files.read('ARGS=--advertise-exit-node\nTS_EXTRA_ARGS=${ARGS:?must set ARGS}\nOTHER=${FROM_PROJECT:?set it}\n');
    expect(files.assignedNames()).toEqual(['ARGS', 'TS_EXTRA_ARGS', 'OTHER']);
    expect(files.assigned('TS_EXTRA_ARGS')).toBe('--advertise-exit-node');
    expect(() => new ComposeEnvFiles(none).read('TS_EXTRA_ARGS=${ARGS:?must set ARGS}\n')).toThrow(ComposeEnvFileError);
  });

  describe('format: raw', () => {
    it('keeps quotes, dollar signs and comments in a value literally', () => {
      const files = new ComposeEnvFiles(none);
      files.read([
        '# comment',
        '',
        "TS_EXTRA_ARGS='--advertise-exit-node'",
        'TPL=${A}',
        'QUOTED="q" # not a comment',
        '  INDENT=3',
        'EMPTY=',
        '',
      ].join('\r\n'), { raw: true });
      expect(files.assigned('TS_EXTRA_ARGS')).toBe("'--advertise-exit-node'");
      expect(files.assigned('TPL')).toBe('${A}');
      expect(files.assigned('QUOTED')).toBe('"q" # not a comment');
      expect(files.assigned('INDENT')).toBe('3');
      expect(files.assigned('EMPTY')).toBe('');
      expect(files.assignedNames()).toEqual(['TS_EXTRA_ARGS', 'TPL', 'QUOTED', 'INDENT', 'EMPTY']);
    });

    it('lets a line with no equals sign inherit only a variable that is set', () => {
      const files = new ComposeEnvFiles(name => (name === 'SET' ? 'v' : undefined));
      files.read('SET\nUNSET\n', { raw: true });
      expect(files.assignedNames()).toEqual(['SET']);
    });

    it('drops a leading byte order mark, as Compose does for a raw file', () => {
      const files = new ComposeEnvFiles(none);
      files.read('\ufeffA=1\nB=$2\n', { raw: true });
      expect(files.assignedNames()).toEqual(['A', 'B']);
      expect(files.assigned('B')).toBe('$2');
    });

    it('refuses what Compose refuses or reads differently from a dotenv file', () => {
      for (const bad of ['B = 2\n', 'export D=4\n', '=x\n']) {
        expect(() => new ComposeEnvFiles(none).read(bad, { raw: true }), bad).toThrow(ComposeEnvFileError);
      }
    });
  });
});
