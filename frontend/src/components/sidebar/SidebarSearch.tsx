import { useEffect, useRef, useState } from 'react';
import { CommandInput } from '@/components/ui/command';

interface SidebarSearchProps {
  value: string;
  onValueChange: (v: string) => void;
}

// 120ms feels instant to a typist (still under the ~150ms human reaction
// floor) while collapsing a burst of keystrokes into one filter rebuild.
// `<Command shouldFilter={false}>` means useStackListState owns the actual
// filter pass; debouncing here directly cuts its rebuild count.
const DEBOUNCE_MS = 120;

export function SidebarSearch({ value, onValueChange }: SidebarSearchProps) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    // Parent value can move for two reasons:
    //   1. Echo of our own debounced emit (lastEmittedRef matches): skip.
    //   2. External reset (e.g., clear-on-filter-change): adopt it.
    if (value === lastEmittedRef.current) return;
    setLocal(value);
  }, [value]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleChange = (next: string) => {
    setLocal(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastEmittedRef.current = next;
      onValueChange(next);
    }, DEBOUNCE_MS);
  };

  return (
    <div className="px-4 py-2 flex-none">
      <CommandInput
        placeholder="Search stacks..."
        value={local}
        onValueChange={handleChange}
        className="h-9 border-none"
      />
    </div>
  );
}
