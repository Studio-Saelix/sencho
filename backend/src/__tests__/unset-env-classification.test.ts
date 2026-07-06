import { describe, it, expect } from 'vitest';
import { classifyUnsetEnvVars } from '../helpers/unsetEnvClassification';
import type { StackEnvSources } from '../helpers/envFileResolution';

function sources(over: Partial<StackEnvSources> = {}): StackEnvSources {
  return {
    stackDir: '/stack',
    baseDir: '/compose',
    composeFiles: [],
    envFiles: [],
    inlineEnvKeysByService: {},
    interpolationRefs: [],
    authoredComposeText: '',
    ...over,
  };
}

describe('classifyUnsetEnvVars', () => {
  it('keeps intentional ${VAR} refs as unset variables', () => {
    const src = sources({
      authoredComposeText: 'services:\n  web:\n    image: nginx\n    environment:\n      - DB_HOST=${DB_HOST}\n',
      interpolationRefs: [{ name: 'DB_HOST', required: false, hasDefault: false, alternate: false }],
    });
    const result = classifyUnsetEnvVars(['DB_HOST', 'E6SDEbshpc'], src);
    expect(result.intentional).toEqual(['DB_HOST']);
    expect(result.literalDollar).toHaveLength(1);
    expect(result.literalDollar[0].likelySecret).toBe(false);
  });

  it('classifies bcrypt hash fragments as literal-dollar warnings without exposing fragments', () => {
    const compose = [
      'services:',
      '  demo:',
      '    image: alpine:3',
      '    environment:',
      '      - EXAMPLE_AUTH_HASH=$2b$10$E6SDEbshpc$vCSrREDACTED',
    ].join('\n');
    const src = sources({
      authoredComposeText: compose,
      inlineEnvKeysByService: { demo: ['EXAMPLE_AUTH_HASH'] },
    });
    const result = classifyUnsetEnvVars(['E6SDEbshpc', 'vCSr'], src);
    expect(result.intentional).toEqual([]);
    expect(result.literalDollar).toHaveLength(1);
    expect(result.literalDollar[0]).toMatchObject({
      envKey: 'EXAMPLE_AUTH_HASH',
      likelySecret: true,
      service: 'demo',
    });
    expect(JSON.stringify(result)).not.toContain('E6SDEbshpc');
    expect(JSON.stringify(result)).not.toContain('vCSr');
  });

  it('classifies map-form bcrypt hash fragments as literal-dollar warnings', () => {
    const compose = [
      'services:',
      '  demo:',
      '    image: alpine:3',
      '    environment:',
      '      EXAMPLE_AUTH_HASH: $2b$10$E6SDEbshpc$vCSrREDACTED',
    ].join('\n');
    const src = sources({
      authoredComposeText: compose,
      inlineEnvKeysByService: { demo: ['EXAMPLE_AUTH_HASH'] },
    });
    const result = classifyUnsetEnvVars(['E6SDEbshpc', 'vCSr'], src);
    expect(result.intentional).toEqual([]);
    expect(result.literalDollar[0]?.envKey).toBe('EXAMPLE_AUTH_HASH');
  });

  it('treats bare $VAR references as intentional', () => {
    const compose = 'services:\n  web:\n    image: nginx\n    environment:\n      - TOKEN=$TOKEN\n';
    const src = sources({ authoredComposeText: compose });
    const result = classifyUnsetEnvVars(['TOKEN'], src);
    expect(result.intentional).toEqual(['TOKEN']);
    expect(result.literalDollar).toEqual([]);
  });

  it('attributes env-file-only spurious fragments to a lone likely-secret key', () => {
    const src = sources({ authoredComposeText: 'services:\n  web:\n    image: nginx\n    env_file:\n      - ./secrets.env\n' });
    const result = classifyUnsetEnvVars(['E6SDEbshpc'], src, ['EXAMPLE_AUTH_HASH']);
    expect(result.intentional).toEqual([]);
    expect(result.literalDollar).toEqual([{ envKey: 'EXAMPLE_AUTH_HASH', likelySecret: true }]);
  });
});
