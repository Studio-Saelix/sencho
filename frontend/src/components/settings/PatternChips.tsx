import { forwardRef, useImperativeHandle, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';

/** Client mirror of backend validateStackPatternForRedos. */
export function validateStackPatternClient(pattern: string): string | null {
  if (pattern.length > 200) return 'Pattern is too long (max 200 characters)';
  const stars = (pattern.match(/\*/g) ?? []).length;
  if (stars > 8) return 'Pattern has too many wildcards (max 8)';
  if (/\*{4,}/.test(pattern)) return 'Pattern must not contain 4+ consecutive wildcards';
  return null;
}

export interface PatternChipsHandle {
  /** Commit pending text if any; returns false when validation blocks save. */
  prepareSave: () => boolean;
}

interface PatternChipsProps {
  patterns: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  'data-testid'?: string;
}

export const PatternChips = forwardRef<PatternChipsHandle, PatternChipsProps>(function PatternChips(
  { patterns, onChange, placeholder = 'Type a pattern and press Enter', 'data-testid': testId },
  ref,
) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tryAdd = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError(null);
      return true;
    }
    const err = validateStackPatternClient(trimmed);
    if (err) {
      setError(err);
      return false;
    }
    if (!patterns.includes(trimmed)) {
      onChange([...patterns, trimmed]);
    }
    setPending('');
    setError(null);
    return true;
  };

  useImperativeHandle(ref, () => ({
    prepareSave: () => {
      if (pending.trim()) return tryAdd(pending);
      for (const p of patterns) {
        const err = validateStackPatternClient(p);
        if (err) {
          setError(err);
          return false;
        }
      }
      setError(null);
      return true;
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      tryAdd(pending);
    }
  };

  const onChangePending = (value: string) => {
    if (value.includes(',')) {
      const parts = value.split(',');
      const last = parts.pop() ?? '';
      for (const part of parts) {
        if (!tryAdd(part)) return;
      }
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
