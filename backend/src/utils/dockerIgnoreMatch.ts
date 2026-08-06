/**
 * Minimal Docker .dockerignore matcher, vendored to avoid a dependency for the
 * git managed-project materializer. Implements the semantics docker's
 * patternmatcher uses (docs.docker.com "Context" / moby/patternmatcher):
 *
 * - Patterns are matched against the path relative to the context root.
 * - A pattern with no slash matches the basename at any depth (`*.md` matches
 *   `README.md` and `sub/README.md`); a pattern with a slash (with or without a
 *   leading `/`) is anchored to the root.
 * - `**` crosses directories; `*`, `?` and `[...]` apply within one segment.
 * - A trailing `/` restricts the pattern to directories.
 * - `!` negates; the LAST matching pattern wins.
 * - `#` starts a comment; `\#` is a literal `#`. Empty lines are ignored.
 * - Dotfiles are matched by default (unlike gitignore).
 *
 * Callers must prune directory subtrees: when a directory path matches, every
 * file beneath it is ignored as well.
 */

export interface DockerIgnoreMatcher {
    /** True when `relPath` (context-root-relative, posix) is ignored. */
    matches(relPath: string, isDir?: boolean): boolean;
}

function escapeRegExpSegment(input: string): string {
    return input.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert one dockerignore segment (`**`, `*`, `?`, `[...]`, literal text) into
 * a regex source that does not cross `/`.
 */
function segmentToRegex(segment: string): string {
    let out = '';
    let i = 0;
    while (i < segment.length) {
        const ch = segment[i];
        if (ch === '*') {
            if (segment[i + 1] === '*') {
                // `**` inside a segment is docker's "match across directories";
                // when it is a full segment the caller emits `.*` instead. Here
                // it can only appear as a partial-segment oddity; treat as `.*`.
                out += '.*';
                i += 2;
                continue;
            }
            out += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            out += '[^/]';
            i += 1;
            continue;
        }
        if (ch === '[') {
            const close = segment.indexOf(']', i + 1);
            if (close === -1) {
                out += '\\[';
                i += 1;
                continue;
            }
            const inner = segment.slice(i + 1, close);
            // Preserve negation and ranges; escape backslashes; keep the class
            // as-is otherwise (docker passes character classes through).
            out += '[' + inner.replace(/\\/g, '\\\\') + ']';
            i = close + 1;
            continue;
        }
        if (ch === '\\' && i + 1 < segment.length) {
            // Escaped char: `\#` yields a literal `#`; any other escape is
            // passed through as the literal character.
            out += escapeRegExpSegment(segment[i + 1]);
            i += 2;
            continue;
        }
        out += escapeRegExpSegment(ch);
        i += 1;
    }
    return out;
}

interface CompiledPattern {
    regex: RegExp;
    negate: boolean;
    dirOnly: boolean;
    basenameOnly: boolean;
}

function compilePattern(rawLine: string): CompiledPattern | null {
    let line = rawLine.trim();
    if (!line) return null;

    // Escaped comment marker: `\#` starts a literal pattern; an unescaped `#`
    // at the start is a comment.
    if (line.startsWith('#')) return null;
    if (line.startsWith('\\#')) {
        line = line.slice(1);
    }

    let negate = false;
    if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1).trim();
        if (!line) return null; // bare `!` is a no-op in docker
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
        dirOnly = true;
        line = line.slice(0, -1);
    }
    if (!line) return null;

    // A leading `/` anchors to the root; strip it (root-anchoring is the
    // default for slash-bearing patterns).
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);

    const segments = line.split('/');
    const basenameOnly = !anchored && segments.length === 1;

    let source = '';
    if (basenameOnly) {
        // Match the basename at any depth.
        source = '(?:^|.*/)' + segmentToRegex(segments[0]) + '$';
    } else {
        // A `**` segment compiles to `(?:.*/)?` (zero or more directories,
        // consuming its own trailing slash) or `.*` when trailing. Separators
        // are inserted between consecutive parts only when the previous part
        // was NOT compiled from `**` (those parts already carry their separator).
        const parts: string[] = [];
        for (let i = 0; i < segments.length; i++) {
            if (segments[i] === '**') {
                parts.push(i === segments.length - 1 ? '.*' : '(?:.*/)?');
            } else {
                parts.push(segmentToRegex(segments[i]));
            }
        }
        source = parts[0];
        for (let i = 1; i < parts.length; i++) {
            if (segments[i - 1] !== '**') source += '/';
            source += parts[i];
        }
    }

    return { regex: new RegExp('^' + source + '$'), negate, dirOnly, basenameOnly };
}

export function compileDockerIgnore(lines: string[]): DockerIgnoreMatcher {
    const patterns = lines.map(compilePattern).filter((p): p is CompiledPattern => p !== null);
    return {
        matches(relPath: string, isDir: boolean): boolean {
            const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalized) return false;
            const base = normalized.slice(normalized.lastIndexOf('/') + 1);
            let ignored = false;
            for (const p of patterns) {
                if (p.dirOnly && !isDir) continue;
                const target = p.basenameOnly ? base : normalized;
                if (p.regex.test(target)) {
                    ignored = !p.negate;
                }
            }
            return ignored;
        },
    };
}

/**
 * Load `.dockerignore` from a directory (docker reads it from the dockerfile's
 * directory when the context and dockerfile differ; callers resolve that).
 * Returns null when no file exists or it cannot be read (nothing ignored).
 */
export async function loadDockerIgnore(rootDir: string): Promise<DockerIgnoreMatcher | null> {
    const fs = await import('fs');
    const path = await import('path');
    try {
        const raw = await fs.promises.readFile(path.join(rootDir, '.dockerignore'), 'utf8');
        return compileDockerIgnore(raw.split(/\r?\n/));
    } catch {
        return null;
    }
}
