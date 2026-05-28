import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [local, setLocalState] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // localRef mirrors `local` for the value-sync effect. Reading state via the
  // ref keeps the effect deps on [value] without dropping a real read of
  // `local`, which would either lie to React or trigger spurious re-runs.
  const localRef = useRef(value);

  const setLocal = useCallback((next: string) => {
    localRef.current = next;
    setLocalState(next);
  }, []);

  useEffect(() => {
    // The parent value moved. Skip only when it already matches what's shown
    // locally: that is the post-emit steady state (the debounce echo settled
    // back through the parent). Any other movement is an external change
    // (clear-on-filter-change, navigation restore, programmatic set, or a
    // coincidence) and must win: cancel any in-flight emit so it cannot undo
    // the reset, then adopt the value.
    if (value === localRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLocal(value);
  }, [value, setLocal]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleChange = (next: string) => {
    setLocal(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
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
