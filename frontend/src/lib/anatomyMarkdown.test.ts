import { describe, it, expect } from 'vitest';
import { buildStackAnatomyMarkdown, type AnatomyMarkdownInput } from './anatomyMarkdown';

const fullInput: AnatomyMarkdownInput = {
  stackName: 'mediawiki',
  services: ['web', 'db'],
  ports: {
    web: [
      { host: '8080', container: '80', proto: 'tcp' },
      { host: '8443', container: '443', proto: 'tcp' },
    ],
  },
  volumes: {
    db: [{ host: './data', container: '/var/lib/mysql' }],
  },
  restart: 'unless-stopped',
  envFile: '.env',
  envVarCount: 12,
  missingVars: ['DB_PASSWORD', 'SECRET_KEY'],
  networkName: 'mediawiki_default',
  gitSource: 'github.com/me/wiki#main',
};

const emptyInput: AnatomyMarkdownInput = {
  stackName: 'blank',
  services: [],
  ports: {},
  volumes: {},
  restart: null,
  envFile: null,
  envVarCount: 0,
  missingVars: [],
  networkName: 'blank_default',
  gitSource: null,
};

describe('buildStackAnatomyMarkdown', () => {
  it('renders a full anatomy as tables, headings, and lists', () => {
    expect(buildStackAnatomyMarkdown(fullInput)).toBe(
      [
        '# mediawiki',
        '',
        '## Services',
        '- `web`',
        '- `db`',
        '',
        '## Ports',
        '| Service | Host | Container | Protocol |',
        '| --- | --- | --- | --- |',
        '| web | 8080 | 80 | tcp |',
        '| web | 8443 | 443 | tcp |',
        '',
        '## Volumes',
        '| Service | Host | Container |',
        '| --- | --- | --- |',
        '| db | ./data | /var/lib/mysql |',
        '',
        '## Restart policy',
        '`unless-stopped`',
        '',
        '## Environment',
        '- File: `.env`',
        '- Variables: 12',
        '- Missing: `DB_PASSWORD`, `SECRET_KEY`',
        '',
        '## Network',
        '`mediawiki_default` (bridge)',
        '',
        '## Source',
        'git · github.com/me/wiki#main',
      ].join('\n'),
    );
  });

  it('renders clean empty-state placeholders', () => {
    expect(buildStackAnatomyMarkdown(emptyInput)).toBe(
      [
        '# blank',
        '',
        '## Services',
        '_none defined_',
        '',
        '## Ports',
        '_none_',
        '',
        '## Volumes',
        '_none_',
        '',
        '## Restart policy',
        '_default_',
        '',
        '## Environment',
        '- File: _none_',
        '',
        '## Network',
        '`blank_default` (bridge)',
        '',
        '## Source',
        'local',
      ].join('\n'),
    );
  });

  it('keeps missing env vars visible', () => {
    const md = buildStackAnatomyMarkdown(fullInput);
    expect(md).toContain('- Missing: `DB_PASSWORD`, `SECRET_KEY`');
  });

  it('emits only the env variable count and key names, never values', () => {
    const md = buildStackAnatomyMarkdown(fullInput);
    expect(md).toContain('- Variables: 12');
    expect(md).toContain('`DB_PASSWORD`');
    // The builder has no access to env values, so no `KEY=value` assignment can appear.
    expect(md).not.toMatch(/DB_PASSWORD\s*=/);
  });

  it('escapes pipe characters in volume table cells', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['svc'],
      volumes: { svc: [{ host: '/data|weird', container: '/mnt' }] },
    });
    expect(md).toContain('| svc | /data\\|weird | /mnt |');
  });

  it('escapes pipe characters in port table cells', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['svc'],
      ports: { svc: [{ host: '127.0.0.1|x', container: '80', proto: 'tcp' }] },
    });
    expect(md).toContain('| svc | 127.0.0.1\\|x | 80 | tcp |');
  });

  it('escapes backslashes before pipes so the escaping cannot be defeated', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['svc'],
      // host `C:\data` -> `C:\\data`; container `a\|b` -> backslash doubled then pipe escaped -> `a\\\|b`
      volumes: { svc: [{ host: 'C:\\data', container: 'a\\|b' }] },
    });
    expect(md).toContain('| svc | C:\\\\data | a\\\\\\|b |');
  });

  it('collapses newlines in a table cell to a single space', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['svc'],
      volumes: { svc: [{ host: 'a\nb', container: '/mnt' }] },
    });
    expect(md).toContain('| svc | a b | /mnt |');
  });

  it('collapses CRLF and lone carriage returns in a table cell', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['svc'],
      volumes: { svc: [{ host: 'a\r\nb', container: 'c\rd' }] },
    });
    expect(md).toContain('| svc | a b | c d |');
  });

  it('flattens rows from multiple services into one table', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      services: ['web', 'db'],
      ports: {
        web: [{ host: '8080', container: '80', proto: 'tcp' }],
        db: [{ host: '5432', container: '5432', proto: 'tcp' }],
      },
    });
    expect(md).toContain('| web | 8080 | 80 | tcp |');
    expect(md).toContain('| db | 5432 | 5432 | tcp |');
  });

  it('omits the Missing line when an env file has no missing vars', () => {
    const md = buildStackAnatomyMarkdown({
      ...emptyInput,
      envFile: '.env',
      envVarCount: 3,
      missingVars: [],
    });
    expect(md).toContain('## Environment\n- File: `.env`\n- Variables: 3');
    expect(md).not.toContain('- Missing:');
  });

  it('is deterministic across distinct but equal inputs', () => {
    const a = buildStackAnatomyMarkdown(fullInput);
    const b = buildStackAnatomyMarkdown({
      ...fullInput,
      ports: { ...fullInput.ports },
      volumes: { ...fullInput.volumes },
    });
    expect(a).toBe(b);
  });
});
