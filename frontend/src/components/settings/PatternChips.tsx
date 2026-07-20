import { forwardRef, useImperativeHandle, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { validateStackPatternClient } from './stackPatternClient';

export type PrepareSaveResult =
  | { ok: true; patterns: string[] }
  | { ok: false };

export interface PatternChipsHandle {
  /**
   * Commit pending text if any and return the validated pattern list to serialize.
   * Callers must use the returned `patterns` instead of a stale parent render.
   */
  prepareSave: () => PrepareSaveResult;
}

interface PatternChipsProps {
  patterns: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  'data-testid'?: string;
}

function appendPattern(base: string[], raw: string): { ok: true; patterns: string[] } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, patterns: base };
  const err = validateStackPatternClient(trimmed);
  if (err) return { ok: false, error: err };
  if (base.includes(trimmed)) return { ok: true, patterns: base };
  return { ok: true, patterns: [...base, trimmed] };
}

export const PatternChips = forwardRef<PatternChipsHandle, PatternChipsProps>(function PatternChips(
  { patterns, onChange, placeholder = 'Type a pattern and press Enter', 'data-testid': testId },
  ref,
) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commitAgainst = (base: string[], raw: string): string[] | null => {
    const result = appendPattern(base, raw);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setError(null);
    return result.patterns;
  };

  useImperativeHandle(ref, () => ({
    prepareSave: () => {
      let next = patterns;
      if (pending.trim()) {
        const committed = commitAgainst(patterns, pending);
        if (!committed) return { ok: false };
        next = committed;
      }
      for (const p of next) {
        const err = validateStackPatternClient(p);
        if (err) {
          setError(err);
          return { ok: false };
        }
      }
      if (next !== patterns) onChange(next);
      setPending('');
      setError(null);
      return { ok: true, patterns: next };
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const next = commitAgainst(patterns, pending);
      if (!next) return;
      if (next !== patterns) onChange(next);
      setPending('');
    }
  };

  const onChangePending = (value: string) => {
    if (value.includes(',')) {
      const parts = value.split(',');
      const last = parts.pop() ?? '';
      let next = patterns;
      for (const part of parts) {
        const committed = commitAgainst(next, part);
        if (!committed) return;
        next = committed;
      }
      if (next !== patterns) onChange(next);
      setPending(last);
      return;
    }
    setPending(value);
    if (error) setError(null);
  };

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <Input
        value={pending}
        onChange={(e) => onChangePending(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-invalid={error != null}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {patterns.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {patterns.map((s) => (
            <Badge key={s} variant="secondary" className="font-mono text-xs gap-1 pr-1">
              {s}
              <button
                type="button"
                onClick={() => onChange(patterns.filter((p) => p !== s))}
                className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"
                aria-label={`Remove ${s}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Use * as a wildcard (for example prod-*). Press Enter or comma to add.
      </p>
    </div>
  );
});
