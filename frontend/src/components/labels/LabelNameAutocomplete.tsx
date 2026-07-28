import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

export interface LabelNameSuggestion {
  name: string;
  scope: 'stack';
  nodeCount: number;
  stackCount: number;
  nodes?: string[];
}

interface LabelNameAutocompleteProps {
  value: string;
  onChange: (next: string) => void;
  suggestions: LabelNameSuggestion[];
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}

/**
 * Free-form label-name input with a suggestion popover. Used by Scheduled
 * Operations label targeting; the operator may type a name that is not
 * suggested (membership is resolved at preview/run time).
 */
export function LabelNameAutocomplete({
  value,
  onChange,
  suggestions,
  disabled,
  placeholder,
  id = 'label-name-input',
}: LabelNameAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q.length === 0) return suggestions;
    return suggestions.filter(s => s.name.toLowerCase().includes(q));
  }, [value, suggestions]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => { if (!disabled) setOpen(true); }}
        placeholder={placeholder}
        className="h-9 text-sm"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-50 w-full rounded-md border border-glass-border bg-popover text-popover-foreground shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]">
          <ul className="max-h-[200px] overflow-y-auto overflow-x-hidden p-1">
            {filtered.map((s) => {
              const nodes = s.nodes ?? [];
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); onChange(s.name); setOpen(false); }}
                    title={nodes.join(', ')}
                    className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 font-mono text-xs text-stat-value hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-left">{s.name}</span>
                      <span className="shrink-0 text-[10px] text-stat-subtitle">
                        {s.stackCount} stack{s.stackCount === 1 ? '' : 's'} · {s.nodeCount} node{s.nodeCount === 1 ? '' : 's'}
                      </span>
                    </span>
                    {nodes.length > 0 && (
                      <span className="w-full truncate text-left text-[10px] text-stat-icon">{nodes.join(', ')}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
