/**
 * Deterministic Markdown export for the Stack Anatomy panel.
 *
 * Turns the already-parsed compose anatomy into a clean Markdown document so an
 * operator can paste a stack summary into Git, Obsidian, BookStack, a README, or
 * a support thread. The builder is pure and side-effect free: the same input
 * always yields byte-identical output.
 *
 * It only ever receives env variable names and a count, never `.env` values, so
 * no secret can leak into the exported text.
 */

export interface PortRow {
  host: string;
  container: string;
  proto: string;
}

export interface VolumeRow {
  host: string;
  container: string;
}

export interface AnatomyMarkdownInput {
  stackName: string;
  services: string[];
  ports: Record<string, PortRow[]>;
  volumes: Record<string, VolumeRow[]>;
  restart: string | null;
  /** Selected env file path, or null when the stack declares none. */
  envFile: string | null;
  envVarCount: number;
  /** Referenced `${VAR}` names with no entry in the env file. */
  missingVars: string[];
  networkName: string;
  /** Formatted Git label (typically `host/repo#branch`) when Git-linked, else null (local). */
  gitSource: string | null;
}

const code = (s: string): string => `\`${s}\``;

// Escape the backslash first (so it cannot defeat the pipe escaping), then pipes
// that would break a table row, then collapse line breaks (CRLF, LF, or a lone CR)
// onto the same line.
function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?|\n/g, ' ');
}

function servicesSection(services: string[]): string {
  if (services.length === 0) return '## Services\n_none defined_';
  return `## Services\n${services.map(s => `- ${code(s)}`).join('\n')}`;
}

function portsSection(ports: Record<string, PortRow[]>): string {
  const rows = Object.entries(ports).flatMap(([svc, list]) =>
    list.map(r => `| ${escapeCell(svc)} | ${escapeCell(r.host)} | ${escapeCell(r.container)} | ${escapeCell(r.proto)} |`),
  );
  if (rows.length === 0) return '## Ports\n_none_';
  return ['## Ports', '| Service | Host | Container | Protocol |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function volumesSection(volumes: Record<string, VolumeRow[]>): string {
  const rows = Object.entries(volumes).flatMap(([svc, list]) =>
    list.map(r => `| ${escapeCell(svc)} | ${escapeCell(r.host)} | ${escapeCell(r.container)} |`),
  );
  if (rows.length === 0) return '## Volumes\n_none_';
  return ['## Volumes', '| Service | Host | Container |', '| --- | --- | --- |', ...rows].join('\n');
}

function environmentSection(envFile: string | null, envVarCount: number, missingVars: string[]): string {
  if (!envFile) return '## Environment\n- File: _none_';
  const lines = [`- File: ${code(envFile)}`, `- Variables: ${envVarCount}`];
  if (missingVars.length > 0) {
    lines.push(`- Missing: ${missingVars.map(code).join(', ')}`);
  }
  return `## Environment\n${lines.join('\n')}`;
}

export function buildStackAnatomyMarkdown(input: AnatomyMarkdownInput): string {
  const restart = input.restart ? code(input.restart) : '_default_';
  const source = input.gitSource ? `git · ${input.gitSource}` : 'local';

  return [
    `# ${input.stackName}`,
    servicesSection(input.services),
    portsSection(input.ports),
    volumesSection(input.volumes),
    `## Restart policy\n${restart}`,
    environmentSection(input.envFile, input.envVarCount, input.missingVars),
    `## Network\n${code(input.networkName)} (bridge)`,
    `## Source\n${source}`,
  ].join('\n\n');
}
