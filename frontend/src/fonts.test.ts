import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface FaceSpec {
  family: string;
  style: 'normal' | 'italic';
  weight: string;
}

interface DeclaredFace {
  family: string;
  style: string;
  weight: string;
  pkg: string;
  file: string;
  range: string;
}

/* Every subset the served stylesheet delivered before the faces moved in-repo. */
const SERVED_SUBSETS: Record<string, string[]> = {
  Geist: ['latin', 'latin-ext', 'cyrillic-ext', 'cyrillic', 'vietnamese'],
  'Geist Mono': ['latin', 'latin-ext', 'cyrillic-ext', 'cyrillic', 'vietnamese', 'symbols2'],
  'Instrument Serif': ['latin', 'latin-ext'],
  'IBM Plex Sans': ['latin', 'latin-ext', 'cyrillic-ext', 'cyrillic', 'greek', 'vietnamese'],
  'IBM Plex Mono': ['latin', 'latin-ext', 'cyrillic-ext', 'cyrillic', 'vietnamese'],
  'Hanken Grotesk': ['latin', 'latin-ext', 'cyrillic-ext', 'vietnamese'],
  'Fira Code': ['latin', 'latin-ext', 'cyrillic-ext', 'cyrillic', 'greek-ext', 'greek', 'symbols2'],
};

/* A character from each script, so a dropped subset or a narrowed range fails this test
   instead of silently falling back to a system face. */
const SUBSET_SAMPLES: Record<string, number[]> = {
  latin: [0x41, 0xff], // A, ÿ
  'latin-ext': [0x100, 0x141], // Ā, Ł
  'cyrillic-ext': [0x460, 0x4c0], // Ѡ, Ӏ
  cyrillic: [0x416, 0x44f], // Ж, я
  'greek-ext': [0x1f00], // ἀ
  greek: [0x3a9, 0x3b1], // Ω, α
  vietnamese: [0x1ea1, 0x1ec3], // ạ, ể
  symbols2: [0x2500, 0x2588], // ─, █
}

const SUBSET_KEYS = [...new Set(Object.values(SERVED_SUBSETS).flat())].sort();

function constIds(source: string, name: string): string[] {
  const block = source.match(new RegExp(`export const ${name}[\\s\\S]*?\\];`));
  if (!block) throw new Error(`missing ${name}`);
  return [...block[0].matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
}

function specsFor(id: string, weights: string[]): FaceSpec[] {
  const weight = id === 'Geist' || id === 'Geist Mono' ? '100 900' : null;
  const cuts = weight ? [weight] : weights;
  return cuts.map((cut) => ({ family: id, style: 'normal', weight: cut }));
}

function fileAgrees(spec: FaceSpec, file: string): boolean {
  if (spec.style === 'italic' && !file.includes('-italic.')) return false;
  if (spec.style === 'normal' && !file.includes('-normal.')) return false;
  if (spec.weight.includes(' ')) return file.includes('-wght-');
  return file.includes(`-${spec.weight}-`);
}

/* The subset is the token run right before the weight and style, so match on the end of the
   stem: a plain substring test for "-latin-" would also match "-latin-ext-". */
function fileNamesSubset(file: string, subset: string): boolean {
  const stem = file.replace(/\.woff2$/, '').split('-').slice(0, -2).join('-');
  return stem.endsWith(`-${subset}`);
}

function themeSpecs(): FaceSpec[] {
  const theme = readFileSync(resolve(frontendRoot, 'src/hooks/use-theme.ts'), 'utf8');
  const indexCss = readFileSync(resolve(frontendRoot, 'src/index.css'), 'utf8');
  const display = indexCss.match(/--font-display:\s*'([^']+)'/)?.[1];
  if (display !== 'Instrument Serif') throw new Error('display face changed');
  return [
    ...constIds(theme, 'UI_FONTS').flatMap((id) => specsFor(id, ['400', '500', '600'])),
    ...constIds(theme, 'MONO_FONTS').flatMap((id) => specsFor(id, ['400', '500'])),
    { family: display, style: 'normal', weight: '400' },
    { family: display, style: 'italic', weight: '400' },
  ];
}

function declaredFaces(css: string): DeclaredFace[] {
  return css.split('@font-face').slice(1).map((block) => {
    const path = block.match(/url\("(@fontsource[^"]+\.woff2)"\)/)?.[1];
    if (!path) throw new Error('face is missing a package file');
    expect(block).toContain('font-display: swap');
    expect(existsSync(resolve(frontendRoot, 'node_modules', path))).toBe(true);
    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
    if (!range) throw new Error(`face is missing a unicode-range: ${path}`);
    return {
      family: block.match(/font-family:\s*'([^']+)'/)?.[1] ?? '',
      style: block.match(/font-style:\s*(normal|italic)/)?.[1] ?? '',
      weight: block.match(/font-weight:\s*([^;]+)/)?.[1]?.trim() ?? '',
      pkg: path.split('/files/')[0],
      file: path.match(/[^/]+\.woff2$/)?.[0] ?? '',
      range,
    };
  });
}

/* The packages publish the range they subset each face to, so the declarations can be checked
   against the shipped definition rather than against a copy of the numbers in this test. */
function publishedRange(pkg: string, subset: string): string {
  const file = resolve(frontendRoot, 'node_modules', pkg, 'unicode.json');
  const ranges = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  const range = ranges[subset];
  if (!range) throw new Error(`${pkg} publishes no ${subset} range`);
  return range;
}

function rangeCovers(range: string, codePoint: number): boolean {
  return range.split(',').some((entry) => {
    const bounds = entry.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    if (!bounds) throw new Error(`unreadable unicode-range entry: ${entry}`);
    const low = Number.parseInt(bounds[1], 16);
    const high = bounds[2] ? Number.parseInt(bounds[2], 16) : low;
    return codePoint >= low && codePoint <= high;
  });
}

describe('self-hosted fonts', () => {
  it('does not request a third-party font host from the document', () => {
    const html = readFileSync(resolve(frontendRoot, 'index.html'), 'utf8');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('loads the faces the theme names, from the package files', () => {
    const main = readFileSync(resolve(frontendRoot, 'src/main.tsx'), 'utf8');
    expect(main).toContain("import './fonts.css'");

    const css = readFileSync(resolve(frontendRoot, 'src/fonts.css'), 'utf8');
    expect(css).not.toMatch(/https?:/);
    expect(css).not.toMatch(/unicode-range:\s*U\+0000/);
    const blocks = declaredFaces(css);

    for (const spec of themeSpecs()) {
      const matches = blocks.filter((block) => (
        block.family === spec.family
        && block.style === spec.style
        && block.weight === spec.weight
        && fileAgrees(spec, block.file)
      ));
      expect(matches.some((block) => fileNamesSubset(block.file, 'latin-ext'))).toBe(true);
      expect(matches.some((block) => fileNamesSubset(block.file, 'latin'))).toBe(true);
    }
  });

  it('covers the scripts the served stylesheet supplied, at every weight and style', () => {
    const css = readFileSync(resolve(frontendRoot, 'src/fonts.css'), 'utf8');
    const blocks = declaredFaces(css);

    // The declared range must be the range the package subsets the face to (a narrowed range
    // fails here), and every face of a subset must declare the same range (a paste slip fails
    // here). The minifier rewrites a range that starts at U+0000, so the file says U+01-FF.
    const rangesBySubset = new Map<string, Set<string>>();
    for (const block of blocks) {
      const subset = SUBSET_KEYS.find((key) => fileNamesSubset(block.file, key));
      if (!subset) continue;
      const published = publishedRange(block.pkg, subset).replace(/^U\+0000-00FF,/, 'U+01-FF,');
      expect(block.range, `${block.file}: range differs from ${block.pkg}/unicode.json`).toBe(published);
      rangesBySubset.set(subset, (rangesBySubset.get(subset) ?? new Set()).add(block.range));
    }
    for (const [subset, ranges] of rangesBySubset) {
      expect([...ranges], `${subset} declares more than one range`).toHaveLength(1);
    }

    for (const spec of themeSpecs()) {
      const subsets = SERVED_SUBSETS[spec.family];
      if (!subsets) throw new Error(`no subset list for ${spec.family}`);
      const own = blocks.filter((block) => (
        block.family === spec.family
        && block.style === spec.style
        && block.weight === spec.weight
        && fileAgrees(spec, block.file)
      ));

      for (const subset of subsets) {
        const where = `${spec.family} ${spec.weight} ${spec.style} ${subset}`;
        const samples = SUBSET_SAMPLES[subset];
        if (!samples) throw new Error(`no sample characters for ${subset}`);
        const matches = own.filter((block) => fileNamesSubset(block.file, subset));
        expect(matches.length, `${where}: no face declared`).toBeGreaterThan(0);
        for (const sample of samples) {
          const point = `U+${sample.toString(16).toUpperCase()}`;
          expect(
            matches.some((block) => rangeCovers(block.range, sample)),
            `${where}: ${point} is not in a declared range`,
          ).toBe(true);
        }
      }
    }
  });
});
