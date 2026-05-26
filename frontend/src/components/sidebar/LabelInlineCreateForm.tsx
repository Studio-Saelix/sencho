import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LABEL_COLORS, type LabelColor } from '@/components/label-types';

interface LabelInlineCreateFormProps {
  onSubmit: (name: string, color: LabelColor) => Promise<void>;
  onCancel: () => void;
}

export function LabelInlineCreateForm({ onSubmit, onCancel }: LabelInlineCreateFormProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('teal');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSubmit(trimmed, color);
    } catch {
      // Parents (createAndAssignLabel) toast and rethrow to signal failure;
      // swallow here so the rejection does not surface as an unhandled
      // event-handler rejection in the browser console.
    } finally {
      // Reset even on success so the form stays interactive if the parent
      // keeps it mounted (e.g. when reused outside the kebab/context menu).
      setSaving(false);
    }
  };

  return (
    <div
      className="px-2 py-2 space-y-2"
      onKeyDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
    >
      <Input
        placeholder="Label name"
        value={name}
        onChange={e => setName(e.target.value)}
        className="h-7 text-xs font-mono"
        maxLength={30}
        autoFocus
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      <div className="flex flex-wrap gap-1">
        {LABEL_COLORS.map(c => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            className={`w-5 h-5 rounded-full border-2 transition-colors ${c === color ? 'border-foreground' : 'border-transparent hover:border-muted-foreground/30'}`}
            style={{ backgroundColor: `var(--label-${c})` }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="flex gap-1">
        <Button
          size="sm"
          className="h-6 text-xs flex-1"
          onClick={submit}
          disabled={saving || !name.trim()}
        >
          {saving ? 'Creating...' : 'Create'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
