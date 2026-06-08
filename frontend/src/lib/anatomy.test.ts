import { describe, it, expect } from 'vitest';
import { assembleAnatomyInput, parseAnatomy, parseEnvKeys, formatGitSource } from './anatomy';

const COMPOSE = `services:
  plex:
    image: plexinc/pms-docker
    restart: unless-stopped
    ports:
      - "32400:32400"
      - "1900:1900/udp"
    volumes:
      - ./config:/config
    env_file: .env
    networks:
      - media
networks:
  media:
`;

describe('parseAnatomy', () => {
  it('extracts services, ports, volumes, restart, env file, and networks', () => {
    const a = parseAnatomy(COMPOSE)!;
    expect(a.services).toEqual(['plex']);
    expect(a.ports.plex).toEqual([
      { host: '32400', container: '32400', proto: 'tcp' },
      { host: '1900', container: '1900', proto: 'udp' },
    ]);
    expect(a.volumes.plex).toEqual([{ host: './config', container: '/config' }]);
    expect(a.restart).toBe('unless-stopped');
    expect(a.envFiles).toEqual(['.env']);
    expect(a.networks).toContain('media');
  });

  it('returns null for empty or unparseable compose', () => {
    expect(parseAnatomy('')).toBeNull();
    expect(parseAnatomy('   ')).toBeNull();
    expect(parseAnatomy('::: not yaml :::\n  - [')).toBeNull();
  });

  it('parses the 3-part bind-IP port form, picking host and container', () => {
    const a = parseAnatomy('services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8080:80"\n')!;
    expect(a.ports.web).toEqual([{ host: '8080', container: '80', proto: 'tcp' }]);
  });

  it('parses long-syntax object ports and volumes', () => {
    const a = parseAnatomy(
      'services:\n  app:\n    image: x\n    ports:\n      - target: 80\n        published: 8080\n        protocol: udp\n    volumes:\n      - type: bind\n        source: ./data\n        target: /data\n',
    )!;
    expect(a.ports.app).toEqual([{ host: '8080', container: '80', proto: 'udp' }]);
    expect(a.volumes.app).toEqual([{ host: './data', container: '/data' }]);
  });

  it('treats ${VAR:-default} as satisfied but ${VAR} as referenced', () => {
    const a = parseAnatomy('services:\n  app:\n    image: x\n    environment:\n      - A=${NEEDED}\n      - B=${HAS:-fallback}\n')!;
    expect(a.referencedVars).toContain('NEEDED');
    expect(a.referencedVars).not.toContain('HAS');
  });
});

describe('parseEnvKeys', () => {
  it('collects keys and ignores comments and blank lines', () => {
    const keys = parseEnvKeys('# comment\nFOO=1\n\nBAR=2\n=novalue\n');
    expect(keys.has('FOO')).toBe(true);
    expect(keys.has('BAR')).toBe(true);
    expect(keys.size).toBe(2);
  });
});

describe('formatGitSource', () => {
  it('formats a URL into host/repo#branch', () => {
    expect(formatGitSource({ repo_url: 'https://github.com/acme/stack.git', branch: 'main' }))
      .toBe('github.com/acme/stack#main');
  });

  it('falls back to repo#branch for a non-URL', () => {
    expect(formatGitSource({ repo_url: 'git@host:repo', branch: 'dev' })).toBe('git@host:repo#dev');
  });
});

describe('assembleAnatomyInput', () => {
  it('builds the markdown input, computing env count and missing vars', () => {
    const input = assembleAnatomyInput({
      stackName: 'plex',
      content: 'services:\n  plex:\n    image: x\n    env_file: .env\n    environment:\n      - TOKEN=${TOKEN}\n',
      envContent: 'OTHER=1\n',
      selectedEnvFile: '.env',
      gitSource: { repo_url: 'https://github.com/acme/plex.git', branch: 'main' },
    })!;
    expect(input.stackName).toBe('plex');
    expect(input.envFile).toBe('.env');
    expect(input.envVarCount).toBe(1);
    expect(input.missingVars).toEqual(['TOKEN']);
    expect(input.gitSource).toBe('github.com/acme/plex#main');
  });

  it('returns null when compose cannot be parsed', () => {
    expect(assembleAnatomyInput({
      stackName: 's', content: '', envContent: '', selectedEnvFile: null, gitSource: null,
    })).toBeNull();
  });

  it('falls back to <stack>_default when no network is declared', () => {
    const input = assembleAnatomyInput({
      stackName: 'web', content: 'services:\n  web:\n    image: x\n', envContent: '', selectedEnvFile: null, gitSource: null,
    })!;
    expect(input.networkName).toBe('web_default');
  });

  it('never carries .env values, only key names and counts', () => {
    const input = assembleAnatomyInput({
      stackName: 's',
      content: 'services:\n  s:\n    image: x\n    env_file: .env\n',
      envContent: 'SECRET=hunter2\nAPI_KEY=abc\n',
      selectedEnvFile: '.env',
      gitSource: null,
    })!;
    expect(input.envVarCount).toBe(2);
    expect(JSON.stringify(input)).not.toContain('hunter2');
    expect(JSON.stringify(input)).not.toContain('abc');
  });
});
