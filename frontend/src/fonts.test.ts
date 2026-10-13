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

function declaredFaces(css: string): { family: string; style: string; weight: string; file: string }[] {
  return css.split('@font-face').slice(1).map((block) => {
    const path = block.match(/url\("(@fontsource[^"]+\.woff2)"\)/)?.[1];
    if (!path) throw new Error('face is missing a package file');
    expect(block).toContain('font-display: swap');
    expect(existsSync(resolve(frontendRoot, 'node_modules', path))).toBe(true);
    return {
      family: block.match(/font-family:\s*'([^']+)'/)?.[1] ?? '',
      style: block.match(/font-style:\s*(normal|italic)/)?.[1] ?? '',
      weight: block.match(/font-weight:\s*([^;]+)/)?.[1]?.trim() ?? '',
      file: path.match(/[^/]+\.woff2$/)?.[0] ?? '',
    };
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
      expect(matches.some((block) => block.file.includes('-latin-ext-'))).toBe(true);
      expect(matches.some((block) => block.file.includes('-latin-') && !block.file.includes('-latin-ext-'))).toBe(true);
    }
  });
});
