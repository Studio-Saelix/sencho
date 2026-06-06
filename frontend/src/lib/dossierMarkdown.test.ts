import { describe, it, expect } from 'vitest';
import { buildStackDossierMarkdown, EMPTY_DOSSIER_FIELDS, type StackDossierFields } from './dossierMarkdown';
import type { AnatomyMarkdownInput } from './anatomyMarkdown';

const anatomy: AnatomyMarkdownInput = {
  stackName: 'plex',
  services: ['plex'],
  ports: { plex: [{ host: '32400', container: '32400', proto: 'tcp' }] },
  volumes: {},
  restart: 'unless-stopped',
  envFile: '.env',
  envVarCount: 4,
  missingVars: ['CLAIM_TOKEN'],
  networkName: 'plex_default',
  gitSource: null,
};

const fields = (over: Partial<StackDossierFields> = {}): StackDossierFields => ({ ...EMPTY_DOSSIER_FIELDS, ...over });

describe('buildStackDossierMarkdown', () => {
  it('returns only the anatomy markdown when no operator notes are set', () => {
    const md = buildStackDossierMarkdown(anatomy, fields());
    expect(md).toContain('# plex');
    expect(md).toContain('## Services');
    expect(md).not.toContain('## Operator notes');
  });

  it('appends an Operator notes section with the filled fields', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({
      purpose: 'Media server',
      owner: 'home',
      static_ip: '10.0.10.4',
      backup_notes: 'rsync config nightly',
    }));
    expect(md).toContain('## Operator notes');
    expect(md).toContain('- **Purpose:** Media server');
    expect(md).toContain('- **Owner:** home');
    expect(md).toContain('- **Static IP:** 10.0.10.4');
    expect(md).toContain('### Backup\nrsync config nightly');
  });

  it('omits empty operator fields', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ purpose: 'only this' }));
    expect(md).toContain('- **Purpose:** only this');
    expect(md).not.toContain('- **Owner:**');
    expect(md).not.toContain('### Firewall');
  });

  it('keeps the generated anatomy facts in the combined export', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ purpose: 'p' }));
    expect(md).toContain('| plex | 32400 | 32400 | tcp |');
    expect(md).toContain('- Variables: 4');
    expect(md).toContain('- Missing: `CLAIM_TOKEN`');
  });

  it('preserves multi-line access URLs as a block', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ access_urls: 'https://a.example\nhttps://b.example' }));
    expect(md).toContain('### Access URLs\nhttps://a.example\nhttps://b.example');
  });

  it('collapses stray newlines in a single-line field into one bullet', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ purpose: 'line one\nline two' }));
    expect(md).toContain('- **Purpose:** line one line two');
  });

  it('the generated facts never emit a .env assignment, only variable names and counts', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ custom_notes: 'see runbook' }));
    expect(md).toContain('- Variables: 4');
    expect(md).toContain('- Missing: `CLAIM_TOKEN`');
    expect(md).not.toMatch(/CLAIM_TOKEN\s*=/);
  });

  it('exports operator notes verbatim (user-authored content is not redacted)', () => {
    const md = buildStackDossierMarkdown(anatomy, fields({ custom_notes: 'DB_PASSWORD=hunter2' }));
    expect(md).toContain('DB_PASSWORD=hunter2');
  });

  it('is deterministic across distinct but equal inputs', () => {
    const f = fields({ purpose: 'x', firewall_notes: 'y' });
    expect(buildStackDossierMarkdown(anatomy, f)).toBe(buildStackDossierMarkdown(anatomy, { ...f }));
  });
});
