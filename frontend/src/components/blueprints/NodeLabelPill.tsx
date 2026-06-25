	import { hashLabel } from '@/lib/label-colors';

	interface NodeLabelPillProps {
	    label: string;
	    onRemove?: () => void;
	    size?: 'sm' | 'md';
	}

	export function NodeLabelPill({ label, onRemove, size = 'md' }: NodeLabelPillProps) {
	    const hue = hashLabel(label);
	    const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0' : 'text-[11px] px-2 py-0.5';
	    return (
	        <span
	            className={`inline-flex items-center gap-1 rounded-md border font-mono ${sizeClasses}`}
	            style={{
	                backgroundColor: `var(--label-${hue}-bg)`,
	                color: `var(--label-${hue})`,
	                borderColor: `color-mix(in oklch, var(--label-${hue}) 30%, transparent)`,
	            }}
	        >
	            {label}
	            {onRemove && (
	                <button
	                    type="button"
	                    onClick={(e) => { e.stopPropagation(); onRemove(); }}
	                    className="opacity-60 hover:opacity-100 ml-0.5 cursor-pointer"
	                    aria-label={`Remove ${label}`}
	                >
	                    ×
	                </button>
	            )}
	        </span>
	    );
	}
