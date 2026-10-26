import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import type { FleetStopLabelSuggestion } from './stopByLabel';

interface LabelAutocompleteProps {
  value: string;
  onChange: (next: string) => void;
  suggestions: FleetStopLabelSuggestion[];
  disabled?: boolean;
  placeholder?: string;
}

// Free-form text input with a Sencho-styled suggestion popover. Replaces the
// browser-native <datalist> so the dropdown matches the rest of the kit (same
// surface tokens as <Combobox>). Each suggestion is a stack label and carries
// its stack/node counts so the scope is unmistakable. The operator can still
// type a name that was not suggested; the server-side match-preview resolves it
// or reports 0 matching stacks.
export function LabelAutocomplete({ value, onChange, suggestions, disabled, placeholder }: LabelAutocompleteProps) {
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

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        id="fleet-stop-label-input"
        aria-label="Stack label"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => { if (!disabled) setOpen(true); }}
        onBlur={() => setOpen(false)}
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
                  // mousedown + preventDefault keeps the input focused so the
                  // selection registers before any blur-driven close fires.
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(s.name); }}
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
