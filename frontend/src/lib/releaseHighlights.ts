import type { BuildInfo } from '@/context/BuildInfoProvider';

const HEADING_RE = /^#{1,3}\s/;
const HIGHLIGHTS_HEADING_RE = /^###\s+Highlights\s*$/;
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Pull the "### Highlights" block out of a GitHub release body: the text
 * between that heading and the next heading, minus the HTML comment that
 * carries the generator's change hash. Returns null when the release has no
 * block (older releases, or a release whose overview could not be generated).
 */
export function extractHighlights(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => HIGHLIGHTS_HEADING_RE.test(line.trim()));
  if (start === -1) return null;
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING_RE.test(line)) break;
    collected.push(line);
  }
  const text = collected
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return text === '' ? null : text;
}

/**
 * The version this instance runs when it is a published stable release.
 * Dev and preview images have no release to read notes from, so they get null.
 */
export function stableReleaseVersion(buildInfo: BuildInfo | null): string | null {
  if (!buildInfo || buildInfo.channel !== 'stable' || !buildInfo.version) return null;
  return STABLE_VERSION_RE.test(buildInfo.version) ? buildInfo.version : null;
}
