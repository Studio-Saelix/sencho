import type { BuildInfo } from '@/context/BuildInfoProvider';

const HEADING_RE = /^ {0,3}#{1,3}\s/;
const HIGHLIGHTS_HEADING_RE = /^###\s+Highlights\s*$/;
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Pull the "### Highlights" block out of a GitHub release body: the text
 * between that heading and the next heading, minus the HTML comment that
 * carries the generator's change hash. Returns null when the release has no
 * block (older releases, or a release whose overview could not be generated).
 *
 * The block layout is written by scripts/release-highlights.mjs and read by the
 * website Worker's extractHighlights too; change the heading, its depth, or the
 * comment form in all three places.
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
  const text = stripHtmlComments(collected.join('\n')).trim();
  return text === '' ? null : text;
}

/** Drop HTML comments (the generator's hash marker) from release markdown before rendering it as text. */
export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The version this instance runs when it is a published stable release
 * (plain X.Y.Z on the stable channel). Dev and preview images, unknown
 * channels, and prerelease or malformed versions have no release to read notes
 * from, so they get null.
 */
export function stableReleaseVersion(buildInfo: BuildInfo | null): string | null {
  if (!buildInfo || buildInfo.channel !== 'stable' || !buildInfo.version) return null;
  return STABLE_VERSION_RE.test(buildInfo.version) ? buildInfo.version : null;
}

/** True when stable X.Y.Z `a` is a later release than `b`. A malformed `b` counts as older. */
export function isNewerStableVersion(a: string, b: string): boolean {
  const parse = (v: string) => (STABLE_VERSION_RE.test(v) ? v.split('.').map(Number) : null);
  const left = parse(a);
  const right = parse(b);
  if (!left) return false;
  if (!right) return true;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
